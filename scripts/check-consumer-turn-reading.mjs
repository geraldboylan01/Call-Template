#!/usr/bin/env node

/**
 * TWO READERS, AND WHAT AGREEMENT IS ALLOWED TO BUY.
 *
 * The deterministic scan reads "two and a half thousand" as 2. For a long time
 * that reading was authoritative, so a EUR 2,500 monthly spend was refused
 * while a EUR 2 monthly spend was written. Every attempt to fix that by
 * bounding the scan's own output failed, because a broken reading cannot anchor
 * a correct one.
 *
 * What replaced it: a second reading of the same turn that never saw the
 * reconciler's answer. Where both readers name the same figure, it may be
 * written. Where they do not, it may not.
 *
 * No model runs here. The readings are supplied directly, because the point of
 * these checks is what the GATE does with a reading — including a wrong one.
 * Whether the reader reads well is a different question, measured against
 * labelled turns by the paid evals.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { applyReconciliationPlan } from '../js/planning/reconciliation.js';
import { createHouseholdProfile, normalizeHouseholdProfile } from '../js/planning/profile.js';
import {
  TURN_READING_SYSTEM_PROMPT,
  normalizeTurnReading
} from '../worker/src/consumer/turn_reading.js';
import { RECONCILIATION_SYSTEM_PROMPT } from '../worker/src/consumer/planner_reconciliation.js';
import { getConsumerConfig } from '../worker/src/consumer/config.js';

const NOW = '2026-08-09T10:00:00.000Z';
const pass = (message) => console.log(`  PASS: ${message}`);
const source = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

function baseProfile() {
  return normalizeHouseholdProfile(createHouseholdProfile({
    profileId: 'profile_turn_reading',
    primaryPersonId: 'primary',
    nowIso: NOW,
    calculationDateIso: '2026-08-09'
  }));
}

const figure = (digits, quote, { currency = null, ambiguous = false, quantity = 'money' } = {}) => ({
  digits, quote, currency, quantity, ambiguous
});

async function propose({ text, quote, amount, currency = 'EUR', figures = null }) {
  const result = await applyReconciliationPlan({
    profile: baseProfile(),
    notes: [],
    plan: {
      schemaVersion: 1,
      planId: 'plan_turn_reading',
      verdict: 'changes_proposed',
      operationGroups: [{
        groupId: 'candidate',
        operations: [{
          operationId: 'proposed',
          op: 'upsert_note',
          factId: 'monthly_spending',
          noteKind: 'fact',
          value: { amount, currency },
          certainty: 'approximate',
          reasonCode: 'missing_note',
          evidence: [{ turnId: 'turn_read', quote }]
        }]
      }]
    },
    transcriptTurns: [{
      turnId: 'turn_read', role: 'user', finalized: true, sequence: 1, text
    }],
    sessionId: 'session_turn_reading',
    transcriptWatermark: 'turn_read',
    baseProfileRevision: 0,
    turnReadings: figures ? [{ turnId: 'turn_read', figures }] : [],
    nowIso: NOW
  });
  return {
    accepted: result.acceptedGroupIds.includes('candidate'),
    code: result.rejectedGroups?.[0]?.code || null
  };
}

const SPEND = 'We spend about two and a half thousand a month on essentials.';
const SPEND_QUOTE = 'about two and a half thousand a month';
const SPEND_READING = [figure(2500, 'two and a half thousand')];

/* ===================== the inversion, closed in both directions =========== */

console.log('\nThe inversion closes both ways at once:');
{
  const recovered = await propose({
    text: SPEND, quote: SPEND_QUOTE, amount: 2500, figures: SPEND_READING
  });
  assert.equal(recovered.accepted, true,
    'a figure both readers name must be writable — this is the whole recovery');
  pass('"two and a half thousand" supports 2500');

  // The same change that admits 2500 must remove 2, or the fix has only made
  // the profile wrong in a new way alongside the old one.
  const truncation = await propose({
    text: SPEND, quote: SPEND_QUOTE, amount: 2, figures: SPEND_READING
  });
  assert.equal(truncation.accepted, false,
    'the scan\'s truncation must stop being authoritative once the turn is read');
  pass('"two and a half thousand" no longer supports 2');
}

/* ============ the reading is a replacement, not an extra source =========== */

console.log('\nA read turn is governed by the reading alone:');
for (const amount of [2_000, 25_000, 250_000, 2_500_000, 4_100, 20_000_000]) {
  const outcome = await propose({
    text: SPEND, quote: SPEND_QUOTE, amount, figures: SPEND_READING
  });
  assert.equal(outcome.accepted, false,
    `${amount} is not what the reading says, so it must be refused`);
}
pass('no figure outside the reading survives, at any magnitude');

/* ============================ an honest "I cannot tell" =================== */

console.log('\nAmbiguity is reported, not resolved:');
{
  const outcome = await propose({
    text: 'Around one eighty, I think.',
    quote: 'Around one eighty',
    amount: 180_000,
    figures: [figure(180_000, 'one eighty', { ambiguous: true })]
  });
  assert.equal(outcome.accepted, false,
    'a reader that said it could not resolve the scale must not have its guess used anyway');
  pass('an ambiguous figure supports nothing, including its own best guess');
}

/* =============================== no arithmetic =========================== */

console.log('\nTwo figures never become a third:');
{
  const outcome = await propose({
    text: 'That is two thousand plus the other three.',
    quote: 'two thousand plus the other three',
    amount: 5_000,
    figures: [figure(2_000, 'two thousand'), figure(3, 'the other three')]
  });
  assert.equal(outcome.accepted, false, 'a total nobody stated must be refused');
  pass('a sum of two read figures is not a read figure');
}

/* ====================== currency travels with the figure ================== */

console.log('\nThe client\'s currency wins:');
{
  const text = 'Mine is a hundred and eighty grand pounds.';
  const quote = 'a hundred and eighty grand pounds';
  const reading = [figure(180_000, 'a hundred and eighty grand pounds', { currency: 'GBP' })];
  assert.equal((await propose({ text, quote, amount: 180_000, currency: 'GBP', figures: reading })).accepted,
    true, 'a stated currency must be usable, not merely un-substitutable');
  assert.equal((await propose({ text, quote, amount: 180_000, currency: 'EUR', figures: reading })).accepted,
    false, 'euro must not silently replace pounds');
  pass('GBP is accepted and EUR refused for the same spoken figure');

  // Nothing stated: the jurisdiction default, same as an unadorned "900 a month".
  const unstated = await propose({
    text: SPEND, quote: SPEND_QUOTE, amount: 2500, currency: 'EUR', figures: SPEND_READING
  });
  assert.equal(unstated.accepted, true, 'an unstated currency still defaults to EUR');
  pass('a figure spoken without a currency defaults to EUR');
}

/* ================= a quote the reading does not cover ==================== */

console.log('\nA figure must come from the span that cites it:');
{
  const outcome = await propose({
    text: 'The pension is two hundred thousand and the mortgage is three forty.',
    quote: 'the mortgage is three forty',
    amount: 200_000,
    figures: [figure(200_000, 'two hundred thousand'), figure(340_000, 'three forty')]
  });
  assert.equal(outcome.accepted, false,
    'a turn\'s other figures must not ground an operation citing a different span');
  pass('the pension figure cannot be written against the mortgage span');
}

/* ========================== absence changes nothing ====================== */

console.log('\nWithout a reading, behaviour is exactly what shipped before:');
{
  assert.equal((await propose({ text: SPEND, quote: SPEND_QUOTE, amount: 2500 })).accepted, false);
  assert.equal((await propose({ text: SPEND, quote: SPEND_QUOTE, amount: 2 })).accepted, true);
  pass('an unread turn keeps the legacy deterministic verdicts, for better and worse');
}

/* ====================== the reading cannot invent its source ============== */

console.log('\nA reading is normalized before it is trusted:');
{
  const clean = normalizeTurnReading({
    figures: [
      { digits: 2500, quote: 'two and a half thousand', currency: 'unstated', ambiguous: false },
      // Words that are not in the turn: the reader may be wrong about what a
      // figure MEANS, but it must not be able to invent where it came from.
      { digits: 999, quote: 'nine hundred and ninety nine', currency: 'EUR', ambiguous: false },
      { digits: Number.NaN, quote: 'two and a half thousand', currency: 'EUR', ambiguous: false }
    ]
  }, { turnId: 'turn_read', transcript: SPEND });
  assert.deepEqual(clean.figures.map((item) => item.digits), [2500],
    'a quote absent from the turn, and a non-numeric figure, must both be dropped');
  assert.equal(clean.figures[0].currency, null, '"unstated" is not a currency');
  pass('fabricated quotes and unusable figures are discarded');
}

/* ============================ shipping posture =========================== */

console.log('\nThe feature ships off:');
{
  assert.equal(getConsumerConfig({}).turnReadingMode, 'off',
    'an unconfigured deployment must behave exactly as it did before this existed');
  assert.equal(getConsumerConfig({ CONSUMER_TURN_READING_MODE: 'aply' }).turnReadingMode, 'off',
    'a typo must fail closed — off, never on');
  assert.equal(getConsumerConfig({ CONSUMER_TURN_READING_MODE: 'shadow' }).turnReadingMode, 'shadow');
  assert.equal(getConsumerConfig({ CONSUMER_TURN_READING_MODE: 'apply' }).turnReadingMode, 'apply');
  pass('off by default, shadow and apply available, typos fail closed');
}

/* ======================= what the reader is told ========================= */

console.log('\nThe reader is asked to read, and nothing else:');
{
  assert.match(TURN_READING_SYSTEM_PROMPT, /NEVER do arithmetic/,
    'the prompt must prohibit arithmetic outright');
  assert.match(TURN_READING_SYSTEM_PROMPT, /two and a half thousand" is 2500/,
    'transcription must be stated as the job, not left to inference');
  assert.match(TURN_READING_SYSTEM_PROMPT, /A scale stated once carries across the sentence/,
    '"hers is ninety" needs the turn read as a whole, or dense answers lose their scale');
  assert.match(TURN_READING_SYSTEM_PROMPT, /"ambiguous": true/,
    'the reader must have a way to decline rather than guess');
  // Independence is a property of the INPUT, so assert what the prompt tells
  // the reader it will and will not receive, rather than banning a word the
  // prompt legitimately uses to deny it.
  assert.match(TURN_READING_SYSTEM_PROMPT, /You are given nothing else — no records, no proposals/,
    'the reader must be told plainly that no proposal or record is coming');
  assert.match(TURN_READING_SYSTEM_PROMPT, /Report only what this client said/,
    'the reader must be aimed at the transcript, not at what would be useful');
  const readerSource = source('../worker/src/consumer/turn_reading.js');
  const request = readerSource.slice(readerSource.indexOf('body: JSON.stringify'));
  for (const leak of ['notes', 'canonicalFacts', 'factContracts', 'voiceWriteOutcomes', 'plan']) {
    assert.ok(!request.includes(leak),
      `the reading request must not carry ${leak}: a reader shown the first `
      + 'reader\'s answer is not a second opinion, it is an echo');
  }
  pass('transcription required, arithmetic forbidden, ambiguity expressible, nothing from the first reader');
}

/* ============= who a figure belongs to is the planner's question ========== */

console.log('\nOwner and entity binding belongs to the planner:');
{
  const gate = source('../js/planning/reconciliation.js');
  const binding = gate.slice(
    gate.indexOf('function assertNumericSemanticBinding'),
    gate.indexOf('const GENERIC_LIABILITY_CUES')
  );
  assert.match(binding, /if \(semanticallyRead\) return;/,
    'a turn the planner read in context must not have its owner re-derived here '
    + 'from cue words and pronouns');

  // The cue machinery still exists for turns nobody read, and that is fine —
  // what must not happen is it deciding meaning for a turn that WAS read.
  assert.match(binding, /quoteHasCue/,
    'the legacy path is deliberately unchanged for unread turns');

  // Structural identity is a different question and is still answered here.
  const identity = gate.slice(
    gate.indexOf('function assertKnownIdentity'),
    gate.indexOf('function assertAggregateIsNotAPosition')
  );
  assert.match(identity, /if \(!semanticallyRead\) \{/,
    'a read turn must not have its owner decided by whether the owner\'s NAME '
    + 'appears in the quote — "hers is ninety" never contains it');
  for (const structural of [
    'new_entity_owner_missing', 'entity_owner_mismatch', 'entity_fact_mismatch'
  ]) {
    assert.ok(identity.includes(structural),
      `${structural} is structural and must hold for every turn, read or not`);
  }
  pass('binding is the planner\'s, existence and legality remain the validator\'s');
}

console.log('\nThe planner is told to bind, and told not to guess:');
{
  const prompt = RECONCILIATION_SYSTEM_PROMPT;
  assert.match(prompt, /WHOSE FACT IS THIS\? Deciding that is your job/,
    'the planner must be given the responsibility explicitly, not by implication');
  assert.match(prompt, /whose catalogue label may simply read "you"/,
    'the primary person is labelled "you", which is why label-matching could never bind them');
  assert.match(prompt, /is TWO pensions, 180000 for the primary and 90000 for the partner/,
    'the dense two-owner case must be shown, since it is the one that fails silently');
  assert.match(prompt, /Never invent, guess, abbreviate or construct an identifier/,
    'the model may choose among supplied ids and must never mint one');
  assert.match(prompt, /return request_clarification naming the ambiguity instead of choosing/,
    'genuine ambiguity must cost a question, not a guess');
  pass('context-based binding required, invented ids forbidden, ambiguity routed to clarification');
}

/* ================= a reviewed turn is diagnosable afterwards ============== */

console.log('\nEach reviewed turn leaves a diagnostic record:');
{
  const { sanitizeRealtimeEventPayload } = await import(
    '../worker/src/consumer/realtime_event_schema.js'
  );
  // AN UNREGISTERED EVENT TYPE IS SILENTLY DISCARDED. Both of these returned
  // null from the sanitizer, so the "full diagnostic record" wrote no rows at
  // all — the observability existed only in the source.
  for (const eventType of [
    'planner.turn_reading.agreement',
    'planner.turn_review.diagnostic',
    'planner.turn_review.binding',
    'live.opening.requested',
    'live.response.continuation_requested',
    'live.response.unsolicited_metadata'
  ]) {
    assert.notEqual(sanitizeRealtimeEventPayload(eventType, {}), null,
      `${eventType} is emitted but unregistered, so nothing is ever written`);
  }
  pass('every event the lane emits is registered and survives sanitization');

  const diagnostic = sanitizeRealtimeEventPayload('planner.turn_review.diagnostic', {
    mode: 'apply',
    clientTurnId: 'turn_1',
    assistantTurnId: 'turn_0',
    readerPromptVersion: 'planeir-turn-reading-v1',
    figuresRead: 2,
    figuresAmbiguous: 1,
    realtimeOutcomeCount: 1,
    operationCount: 3,
    acceptedCount: 2,
    clarificationCount: 1,
    rejectedCount: 1,
    profileChanged: true,
    ledgerChanged: true,
    status: 'applied'
  });
  for (const field of [
    'clientTurnId', 'assistantTurnId', 'readerPromptVersion', 'figuresRead',
    'figuresAmbiguous', 'realtimeOutcomeCount', 'operationCount', 'acceptedCount',
    'clarificationCount', 'rejectedCount', 'profileChanged', 'status'
  ]) {
    assert.ok(Object.hasOwn(diagnostic, field),
      `the diagnostic must survive sanitization carrying ${field}`);
  }

  const binding = sanitizeRealtimeEventPayload('planner.turn_review.binding', {
    clientTurnId: 'turn_1',
    operationId: 'op_1',
    op: 'upsert_note',
    factId: 'pension_positions',
    ownerId: 'partner',
    entityId: 'recon_slot_pension_positions_1',
    accepted: true,
    rejectionCode: null
  });
  assert.equal(binding.ownerId, 'partner',
    'a wrong binding is the thing worth seeing, so the owner chosen must survive');
  assert.equal(binding.entityId, 'recon_slot_pension_positions_1');
  pass('the turn, the reader, the comparison and every binding are all recoverable');

  // The schema admits no arrays or objects, which is what keeps client speech
  // out of the event stream. Assert the emitter respects that rather than
  // relying on the sanitizer to quietly drop half a payload.
  const worker = source('../worker/src/consumer/planner_reconciliation.js');
  const emitter = worker.slice(
    worker.indexOf('function recordTurnReadingAgreement'),
    worker.indexOf('/** Every number inside an operation value')
  );
  assert.ok(!/payload: \{[\s\S]*?\.slice\(0, \d+\)\.map\(/.test(emitter),
    'no event payload may carry a list of figures or operations; the transcript '
    + 'store holds the client\'s words, behind its own access controls');
  pass('diagnostics carry counts and identifiers, never the client\'s figures');
}

/* ============== a hundredth of a figure is not that figure =============== */

// THE CONVERSION NEEDS BOTH HALVES. Letting every read figure also authorise a
// hundredth of itself was introduced to reconcile "six percent" with the 0.06 a
// rate field stores. It reconciled far more than that: a read 2500 authorised a
// EUR 25 monthly spend, 400 authorised 4, 180000 authorised 1800. The client
// must have expressed a proportion AND the destination must be a field the
// schema stores as a fraction.
console.log('\nA hundredth of a figure is not that figure:');
for (const amount of [25, 250, 0.25]) {
  const outcome = await propose({
    text: SPEND, quote: SPEND_QUOTE, amount, figures: SPEND_READING
  });
  assert.equal(outcome.accepted, false,
    `${amount} is a fraction of the read figure, not the read figure`);
}
pass('a money figure never authorises a hundredth of itself');

{
  // And the case the conversion exists for still works, but only when the
  // reader actually said the client expressed a proportion.
  const rateOf = async (quantity) => {
    const result = await applyReconciliationPlan({
      profile: baseProfile(),
      notes: [],
      plan: {
        schemaVersion: 1,
        planId: 'plan_rate',
        verdict: 'changes_proposed',
        operationGroups: [{
          groupId: 'candidate',
          operations: [{
            operationId: 'proposed',
            op: 'upsert_note',
            factId: 'pension_positions',
            noteKind: 'position',
            entityId: 'slot_1',
            ownerId: 'primary',
            value: {
              pensionId: 'slot_1',
              ownerId: 'primary',
              type: 'occupational',
              label: 'Mine',
              employeeContributionRate: 0.06
            },
            certainty: 'approximate',
            reasonCode: 'missing_note',
            evidence: [{ turnId: 'turn_read', quote: 'I put in six percent' }]
          }]
        }]
      },
      transcriptTurns: [{
        turnId: 'turn_read', role: 'user', finalized: true, sequence: 1,
        text: 'I put in six percent.'
      }],
      sessionId: 'session_turn_reading',
      transcriptWatermark: 'turn_read',
      baseProfileRevision: 0,
      owners: [{ ownerId: 'primary', label: 'you', role: 'primary', aliases: ['you'] }],
      entities: [{
        entityId: 'slot_1', label: 'new pension 1', newEntitySlot: true,
        collection: 'pensions', factIds: ['pension_positions'], ownerIds: []
      }],
      turnReadings: [{
        turnId: 'turn_read',
        figures: [figure(6, 'six percent', { quantity })]
      }],
      nowIso: NOW
    });
    return result.acceptedOperationIds.length > 0;
  };
  assert.equal(await rateOf('percent'), true,
    'a proportion the client stated must reach the rate field the schema stores as a fraction');
  assert.equal(await rateOf('money'), false,
    'the conversion needs the READER to have said this was a proportion, not just a rate-shaped field');
  pass('0.06 is accepted for "six percent" only into a rate field, and only when read as a percent');
}

/* ============== identical words twice is ambiguous provenance ============= */

console.log('\nRepeated identical words cannot prove which occurrence:');
{
  const outcome = await propose({
    text: 'Rent is 500 and the car is 500.',
    quote: 'Rent is 500',
    amount: 500,
    figures: [figure(500, '500')]
  });
  assert.equal(outcome.accepted, false,
    'a quote matching two places in the turn cannot say which one it came from');
  pass('a duplicated quote fails closed rather than resolving to both');
}

/* ============ a record that names its owner has named its owner ========== */

// positionContracts gives every collection an ownerKey, and a well-formed
// record fills it. A planner that filled the record but left the
// operation-level ownerId off had the whole write discarded as "owner
// missing" — an owner that was never in doubt, thrown away on a technicality.
console.log('\nAn owner stated in the record is an owner:');
{
  const writePension = async (operationOwnerId, recordOwnerId) => {
    const result = await applyReconciliationPlan({
      profile: baseProfile(),
      notes: [],
      plan: {
        schemaVersion: 1,
        planId: 'plan_owner',
        verdict: 'changes_proposed',
        operationGroups: [{
          groupId: 'candidate',
          operations: [{
            operationId: 'proposed',
            op: 'upsert_note',
            factId: 'pension_positions',
            noteKind: 'position',
            entityId: 'slot_1',
            ...(operationOwnerId ? { ownerId: operationOwnerId } : {}),
            value: {
              pensionId: 'slot_1',
              ownerId: recordOwnerId,
              type: 'occupational',
              label: 'Mine',
              currentValue: { amount: 180_000, currency: 'EUR' }
            },
            certainty: 'approximate',
            reasonCode: 'missing_note',
            evidence: [{ turnId: 'turn_read', quote: 'a hundred and eighty grand' }]
          }]
        }]
      },
      transcriptTurns: [{
        turnId: 'turn_read', role: 'user', finalized: true, sequence: 1,
        text: 'My pension is a hundred and eighty grand.'
      }],
      sessionId: 'session_turn_reading',
      transcriptWatermark: 'turn_read',
      baseProfileRevision: 0,
      owners: [{ ownerId: 'primary', label: 'you', role: 'primary', aliases: ['you'] }],
      entities: [{
        entityId: 'slot_1', label: 'new pension 1', newEntitySlot: true,
        collection: 'pensions', factIds: ['pension_positions'], ownerIds: []
      }],
      turnReadings: [{
        turnId: 'turn_read',
        figures: [figure(180_000, 'a hundred and eighty grand')]
      }],
      nowIso: NOW
    });
    return {
      accepted: result.acceptedOperationIds.length > 0,
      code: result.rejectedGroups?.[0]?.code || null
    };
  };

  assert.equal((await writePension('primary', 'primary')).accepted, true,
    'the ordinary case must keep working');
  assert.equal((await writePension(null, 'primary')).accepted, true,
    'an owner named in the canonical ownerId field the schema defines is not a missing owner');
  const invented = await writePension(null, 'someone_else');
  assert.equal(invented.accepted, false,
    'recovery reads the schema, it does not accept an owner the household does not have');
  pass('an owner stated in the record is recovered; an invented one still fails');
}

console.log('\ncheck-consumer-turn-reading: the agreement gate holds.');
