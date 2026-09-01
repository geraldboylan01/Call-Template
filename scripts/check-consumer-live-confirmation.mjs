#!/usr/bin/env node

/**
 * THE CONFIRMATION BARRIER, IN SEQUENCE.
 *
 * THE DEFECT THIS PINS. `plannerReconciliationPreflight` used to require that
 * the CONFIRMING turn had itself been reconciled. Reconciliation for a turn is
 * scheduled from `response.done`; the `confirm_and_run` call for that turn
 * arrives on `response.function_call_arguments.done`, which always comes first.
 * So the watermark sat exactly one turn behind the turn being confirmed, on
 * every attempt, and `confirm_and_run` could not succeed in `shadow` or `apply`
 * at all — the deterministic module could never run with the reconciler on.
 *
 * WHY NOTHING CAUGHT IT. The preflight was unit-tested as a pure predicate
 * against hand-built lease rows, which is correct in isolation and unreachable
 * in sequence; and production runs `legacy`, where the gate returns before any
 * of it. A predicate test cannot find this. Only driving the real Durable
 * Object through the real provider event order can, so that is what this does.
 *
 * WHAT IS REAL: the Durable Object, the live tool dispatcher, real D1, the real
 * scheduler and the real reconciler. Only the planner MODEL is scripted, and
 * only so a test can choose whether a review succeeds or fails.
 */

import assert from 'node:assert/strict';

import { attachLiveSession, newLiveMeeting, settle } from './live-harness/session.mjs';
import { LiveProviderSimulator } from './live-harness/provider.mjs';
import { scriptedPlanner } from './live-harness/scripted-planner.mjs';

const pass = (message) => console.info(`[ConsumerLiveConfirmation] PASS: ${message}`);

/** A meeting far enough along that only the barrier can refuse the run. */
async function meetingReadyToConfirm(label, mode, planFor, options = {}) {
  const meeting = await newLiveMeeting(label, {
    CONSUMER_PLANNER_RECONCILIATION_MODE: mode,
    ...(options.turnReadingMode ? { CONSUMER_TURN_READING_MODE: options.turnReadingMode } : {})
  });
  const { session, durable, provider } = await attachLiveSession(meeting);
  const simulator = new LiveProviderSimulator({ session, durable, provider });
  const planner = scriptedPlanner(planFor, { readFor: options.readFor || null });

  const say = async (clientText, facts = null) => {
    const turn = await simulator.turn({
      clientText,
      act: async ({ callTool }) => {
        if (facts) await callTool('save_facts', { facts });
        return { speech: 'Noted.' };
      }
    });
    await settle(durable, session);
    return turn;
  };

  // Enough to make one analysis genuinely runnable. Every figure is phrased so
  // the live numeric guard accepts it, because what is under test here is the
  // barrier, not capture.
  await say("I'm 57 and I want to get my pension sorted out before I retire.", [
    { factId: 'primary_goal', value: { type: 'improve_pension' }, certainty: 'exact' },
    { factId: 'person_current_age', value: 57, certainty: 'exact' }
  ]);
  await say('My partner is 59.', [
    { factId: 'partner_person', value: { operation: 'upsert', entityId: 'partner', age: 59 }, certainty: 'exact' }
  ]);
  await say("I'd like to retire at 62 if the numbers work.", [
    { factId: 'intended_retirement_age', value: 62, certainty: 'exact' }
  ]);
  await say('The occupational pension is worth about 319,000 right now.', [
    {
      factId: 'pension_positions',
      value: {
        operation: 'upsert', entityId: 'occ1', type: 'occupational', owner: 'primary',
        currentValue: { amount: 319000, currency: 'EUR' }
      },
      certainty: 'approximate'
    }
  ]);
  await say('I earn 95,000 gross a year from my job.', [
    {
      factId: 'income_sources',
      value: {
        operation: 'upsert', entityId: 'job1', type: 'employment', owner: 'primary',
        grossAnnual: { amount: 95000, currency: 'EUR' }
      },
      certainty: 'exact'
    }
  ]);
  await say('I put in 6 percent and the company puts in 8 percent.', [
    { factId: 'pension_employee_contribution_rate', value: 6, certainty: 'exact' },
    { factId: 'pension_employer_contribution_rate', value: 8, certainty: 'exact' }
  ]);
  await say("Yes, it's still being paid into every month.", [
    { factId: 'pension_contribution_status', value: 'active', certainty: 'exact' }
  ]);
  await say("I'd want about 45,000 a year.", [
    { factId: 'target_retirement_income', value: { amount: 45000, currency: 'EUR' }, certainty: 'approximate' }
  ]);
  await say('My partner has no pension of their own.', [
    { factId: 'pension_positions', value: { operation: 'confirm_none', owner: 'partner' }, certainty: 'exact' }
  ]);

  return { meeting, session, durable, provider, simulator, planner, say };
}


/**
 * An honest reader for these fixtures: it reports the figures the client's turn
 * actually contains, and nothing else.
 *
 * A reader that returned nothing would make EVERY captured figure look
 * unsupported, so the barrier would block on correct work and the test would
 * pass for entirely the wrong reason. What is under test is whether a stored
 * figure the reading CONTRADICTS is caught — which needs a reading that agrees
 * with everything else.
 */
function readTurnHonestly({ clientTurn }) {
  const figures = [];
  if (clientTurn.includes('two and a half thousand')) {
    figures.push({
      digits: 2500,
      quote: 'two and a half thousand',
      currency: 'unstated',
      quantity: 'money',
      attribution: 'joint',
      ambiguous: false
    });
  }
  for (const match of clientTurn.matchAll(/\d[\d,]*/g)) {
    const quote = match[0];
    figures.push({
      digits: Number(quote.replaceAll(',', '')),
      quote,
      currency: 'unstated',
      quantity: /percent/i.test(clientTurn) ? 'percent' : 'money',
      attribution: 'speaker',
      ambiguous: false
    });
  }
  return figures;
}

/** One confirmation attempt, returning what the gate decided. */
async function confirm(rig, { clientText = 'Yes, go ahead and run it.', facts = null } = {}) {
  let result = null;
  await rig.simulator.turn({
    clientText,
    act: async ({ callTool }) => {
      if (facts) await callTool('save_facts', { facts });
      const call = await callTool('confirm_and_run', {});
      result = call.result;
      return { speech: 'One moment.' };
    }
  });
  await settle(rig.durable, rig.session);
  return result;
}

const blockedByBarrier = (result) => result?.code === 'reconciliation_pending';

/* ============================================ 1 + 5: pure confirmation, both */

for (const mode of ['shadow', 'apply']) {
  const rig = await meetingReadyToConfirm(`confirm-clean-${mode}`, mode, () => null);
  assert.deepEqual(rig.session.unreviewedMaterialTurns, [],
    `${mode}: every material turn must have been reviewed before the confirmation`);

  const result = await confirm(rig);
  assert.equal(blockedByBarrier(result), false,
    `${mode}: a confirmation carrying no new facts must not be blocked by the barrier`);
  if (mode === 'shadow') {
    // Shadow reviews without writing the profile, so passing the barrier here
    // means the deterministic module genuinely runs. `apply` asserts only the
    // barrier: its profile write currently mis-shapes `targetIncomeToday`, a
    // SEPARATE defect from the one this file pins, and conflating the two would
    // make this regression fail for the wrong reason.
    assert.equal(result?.ok, true, 'shadow: the analyses must actually run');
    assert.equal(result?.status, 'complete', 'shadow: and complete');
  }
  rig.planner.restore();
  pass(`${mode} — a pure confirmation runs once every material turn is reviewed`);
}

/* ================================ 2: an earlier material turn is unreviewed */

for (const mode of ['shadow', 'apply']) {
  // The planner fails on the LAST material turn, so its review never lands.
  let calls = 0;
  const rig = await meetingReadyToConfirm(`confirm-unreviewed-${mode}`, mode, () => {
    calls += 1;
    return calls >= 7 ? { fail: true } : null;
  });

  assert.ok(rig.session.unreviewedMaterialTurns.length > 0,
    `${mode}: the fixture must genuinely leave a material turn unreviewed`);

  const result = await confirm(rig);
  assert.equal(blockedByBarrier(result), true,
    `${mode}: an unreviewed material turn must block the run`);
  rig.planner.restore();
  pass(`${mode} — a failed review leaves its material turn blocking, not released`);
}

/* ====================== 3: the confirming turn carries its own correction */

/**
 * TWO GATES STAND HERE, AND THE ORDER MATTERS.
 *
 * A turn that states a correction is not a clean "run it", so
 * `classifySpokenPlanConfirmation` returns `ambiguous` and refuses before the
 * barrier is ever consulted. That is correct, and it means the literal case
 * "the confirming turn carries a correction" is unreachable at the barrier.
 *
 * The reachable form is note activity the TRANSCRIPT does not carry: the model
 * attempts a save on an otherwise-clean confirmation and the numeric guard
 * refuses it. The affirmation is unambiguous, so the barrier is reached — and
 * an unresolved rejection is exactly the "material" it must hold for.
 */
{
  const rig = await meetingReadyToConfirm('confirm-with-correction', 'apply', () => null);
  assert.deepEqual(rig.session.unreviewedMaterialTurns, [],
    'the meeting must start this case fully reviewed, or it proves nothing');

  // 3a — clean affirmation, unresolved note activity on the same turn.
  const withRejectedSave = await confirm(rig, {
    clientText: 'Yes, go ahead and run it.',
    facts: [{ factId: 'target_retirement_income', value: { amount: 51000, currency: 'EUR' }, certainty: 'exact' }]
  });
  assert.equal(blockedByBarrier(withRejectedSave), true,
    'unresolved note activity on the confirming turn must block the run');

  // The barrier must also SCHEDULE the review it is waiting for, or a refusal
  // becomes a deadlock — which is the failure mode this whole file exists for.
  assert.deepEqual(rig.session.unreviewedMaterialTurns, [],
    'the refusal must leave the outstanding turn reviewed, not outstanding forever');

  const after = await confirm(rig, { clientText: 'Yes, please go ahead.' });
  assert.equal(blockedByBarrier(after), false,
    'once that turn is reviewed the confirmation must proceed');
  rig.planner.restore();
  pass('apply — unresolved note activity blocks the confirming turn, then clears');
}

/* 3b — a spoken correction never reaches the barrier, and is refused anyway. */

{
  const rig = await meetingReadyToConfirm('confirm-spoken-correction', 'apply', () => null);
  const corrected = await confirm(rig, {
    clientText: 'Yes, go ahead — though actually I want to retire at 63, not 62.',
    facts: [{ factId: 'intended_retirement_age', value: 63, certainty: 'exact' }]
  });
  assert.equal(corrected?.ok, false,
    'a turn that corrects something while agreeing must not run the analyses');
  assert.equal(corrected?.code, 'confirmation_required',
    'and the spoken-confirmation gate is what refuses it, before the barrier');
  rig.planner.restore();
  pass('apply — a correction voiced while confirming is refused by the spoken gate');
}

/* ============================================== 4: legacy is left untouched */

{
  let plannerCalls = 0;
  const rig = await meetingReadyToConfirm('confirm-legacy', 'legacy', () => {
    plannerCalls += 1;
    return null;
  });
  const result = await confirm(rig);
  assert.equal(blockedByBarrier(result), false,
    'legacy must not consult the barrier at all');
  assert.equal(result?.ok, true, 'and the analyses must actually run');
  assert.deepEqual(rig.session.unreviewedMaterialTurns, [],
    'legacy must not accumulate material turns it will never review');
  const rows = (await rig.meeting.env.CONSUMER_DB.prepare(
    'SELECT id FROM consumer_planner_reconciliations WHERE session_id = ?'
  ).bind(rig.meeting.sessionId).all()).results || [];
  assert.equal(rows.length, 0, 'legacy must run no reconciliation at all');
  rig.planner.restore();
  pass('legacy — unchanged: no barrier, no reconciler, the module runs');
}

/* ========== a clean plan cannot clear a proposal it never examined ========= */

// THE BARRIER PROVED THE WRONG THING. It asked whether a checkpoint had
// COMPLETED, and a plan returning `clean` with an empty reviewedNoteIds
// completes perfectly well while dispositioning nothing. The review receipt was
// whatever the model volunteered, so a fast-lane figure the independent reading
// contradicts was never examined, had its material turn retired by ordinal, and
// `confirm_and_run` opened over it. Nothing was rejected because nothing was
// looked at.
//
// The server now checks the proposals itself instead of waiting to be handed a
// list. It blocks on what it can DEMONSTRATE — a stored figure the reading of
// the client's own turn does not contain — and never on the reviewer's silence.
const SPENDING = 'We spend about 2,500 a month on essentials.';

async function meetingWithSpendingRead(label, digits) {
  const rig = await meetingReadyToConfirm(label, 'apply', () => null, {
    turnReadingMode: 'apply',
    readFor: (request) => (request.clientTurn === SPENDING
      ? [{
        digits,
        quote: '2,500',
        currency: 'unstated',
        quantity: 'money',
        attribution: 'joint',
        ambiguous: false
      }]
      : readTurnHonestly(request))
  });
  const said = await rig.say(SPENDING, [
    { factId: 'monthly_spending', value: { amount: 2500, currency: 'EUR' }, certainty: 'approximate' }
  ]);
  // The fast lane must genuinely have written it, or there is no proposal for
  // the barrier to be tested against and the case proves nothing.
  const results = (said?.toolCalls || []).map((call) => call.result);
  assert.ok(results.some((result) => (result?.saved || []).length > 0),
    `${label}: the fast lane must have accepted the figure`);
  return rig;
}

{
  // The independent reader makes out a different figure from the one the fast
  // lane wrote. Which of them is right is not this gate's business; that they
  // disagree is, and a disputed figure must not reach a calculation.
  const rig = await meetingWithSpendingRead('confirm-reading-disagrees', 3_200);
  assert.equal(blockedByBarrier(await confirm(rig)), true,
    'a figure the independent reading contradicts must not reach a calculation, '
    + 'however clean the plan that ignored it');
  // Twice, because the first refusal also SCHEDULES the review it is waiting
  // for — a barrier that merely lagged a turn would open on the retry.
  assert.equal(blockedByBarrier(await confirm(rig, { clientText: 'Yes, please go ahead.' })), true,
    'and it must still not, after the review it scheduled has run');
  assert.ok(rig.planner.readings().some((entry) => entry.figures.length > 0),
    'the independent reader must actually have run — a test where it returned '
    + 'nothing would pass for the wrong reason');
  rig.planner.restore();
  pass('apply — a clean plan cannot clear a proposal the reading contradicts');
}

{
  // AND SILENCE IS NOT EVIDENCE. The first version of this blocked on every
  // provisional note the reviewer had not mentioned, which held the barrier
  // shut on correct figures until the meeting could not finish — and the
  // retraction meant to release it deleted a correct EUR 319,000 pension and a
  // correct EUR 95,000 income. A reviewer that has not got round to a note has
  // found nothing wrong with it.
  const rig = await meetingWithSpendingRead('confirm-reading-agrees', 2_500);
  await confirm(rig);
  const result = await confirm(rig, { clientText: 'Yes, please go ahead.' });
  assert.equal(blockedByBarrier(result), false,
    'a figure the reading agrees with must not be held back by a silent reviewer');
  assert.equal(result?.ok, true, 'and the analyses must actually run');
  rig.planner.restore();
  pass('apply — an unmentioned proposal the reading agrees with does not block');
}

{
  // AND IT MUST CONVERGE. A disputed figure blocks, but not forever: after a
  // bounded number of passes the question goes to the CLIENT — the one party
  // who can actually settle it — and the barrier stops holding every other
  // analysis hostage to it. Without this the first refusal is a dead end and
  // the meeting simply cannot finish, which is worse than the hole it closes.
  const rig = await meetingWithSpendingRead('confirm-escalates', 3_200);
  let opened = false;
  for (let attempt = 0; attempt < 8 && !opened; attempt += 1) {
    opened = !blockedByBarrier(await confirm(rig, { clientText: 'Yes, please go ahead.' }));
  }
  assert.equal(opened, true,
    'a disputed figure must end in a question to the client, not a dead end');
  assert.deepEqual(rig.session.undispositionedNotes, [],
    'and the obligation must be discharged rather than merely ignored');
  rig.planner.restore();
  pass('apply — a disputed figure is escalated to the client, never left blocking forever');
}

console.info('\n[ConsumerLiveConfirmation] PASS: the confirmation barrier admits reviewed work and only reviewed work');
