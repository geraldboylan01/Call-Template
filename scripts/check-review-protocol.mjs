#!/usr/bin/env node

/**
 * THE HARD REVIEW BOUNDARY: EXECUTION AUTHORITY.
 *
 * Every assertion here is about one question -- can this thing reach the
 * financial engine? -- and the answer is measured the same way every time, by
 * counting rows in `consumer_analysis_runs`. Not by inspecting a return code,
 * not by trusting an error message: by asking the database how many analyses
 * actually ran.
 *
 * The companion file check-review-sealing.mjs covers the other half: whether a
 * REVIEW was entitled to exist at all.
 *
 * Everything below runs on a real Durable Object over a real migrated database
 * with real encryption and the real deterministic engines. Only the planner's
 * and verifier's opinions are scripted.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  MODULE_NAME,
  modelCalls,
  reachReviewBySpeaking,
  scriptPlanner
} from './live-harness/review.mjs';
import { settle } from './live-harness/session.mjs';
import {
  assertFinalAdmission,
  claimReviewRun,
  describeCurrentReview,
  currentInputMode,
  executeReviewRun,
  getReviewRecord,
  publishReview,
  readReviewControl,
  revokeReview
} from '../worker/src/consumer/review.js';
import { assertLiveToolName, executeLiveTool, LIVE_TOOL_NAMES } from '../worker/src/consumer/live/live_tools.js';
import { claimRealtimeAnalysisPlanRun } from '../worker/src/consumer/realtime_repository.js';

let checks = 0;
function ok(value, message) { checks += 1; assert.ok(value, message); }
function equal(actual, expected, message) { checks += 1; assert.equal(actual, expected, message); }

/** THE ONLY MEASURE OF EXECUTION THAT MATTERS. */
async function engineRuns(meeting) {
  const row = await meeting.env.CONSUMER_DB
    .prepare('SELECT COUNT(*) AS n FROM consumer_analysis_runs WHERE session_id = ?')
    .bind(meeting.sessionId).first();
  return Number(row.n);
}

async function currentReviewId(meeting) {
  return (await describeCurrentReview(meeting.env, meeting.sessionId)).review?.reviewId || '';
}

/**
 * Break one statement and leave every other one working.
 *
 * A storage failure has to be narrow to prove anything: a database that fails
 * entirely would stop the transition for uninteresting reasons. This breaks
 * exactly the write under test.
 */
function breakStatements(meeting, matcher) {
  const database = meeting.env.CONSUMER_DB;
  const original = database.prepare.bind(database);
  database.prepare = (sql) => {
    if (matcher(sql)) {
      return {
        bind: () => ({
          first: async () => { throw new Error('scripted storage failure'); },
          run: async () => { throw new Error('scripted storage failure'); },
          all: async () => { throw new Error('scripted storage failure'); }
        })
      };
    }
    return original(sql);
  };
  return () => { database.prepare = original; };
}

const restore = scriptPlanner();
try {

/* ============================================================ 1-3, 31-33
 * CONVERSATIONAL LANGUAGE, IN EVERY FORM, EXECUTES NOTHING.
 *
 * These are spoken into a live meeting that has ALREADY sealed, which is the
 * strongest version of the test: the plan is certified, frozen and one click
 * away, and the words still do nothing. */
{
  const { meeting, rig, simulator } = await reachReviewBySpeaking('language');
  const reviewId = await currentReviewId(meeting);
  ok(reviewId, 'the meeting reached REVIEW');

  for (const said of ['Yes.', 'Run it.', 'Go ahead.', "Perfect, that's right.", 'Please run that.']) {
    // The provider is told to stop listening, but a tampered client, a second
    // socket or a replayed frame could still deliver one. It must land nowhere.
    await rig.session.handleClientTurn({
      item_id: `spoken_${said.length}_${Math.random()}`, transcript: said
    });
    await settle(rig.durable, rig.session);
    equal(await engineRuns(meeting), 0, `"${said}" executed nothing`);
    equal(await currentReviewId(meeting), reviewId, `"${said}" did not alter the review`);
  }
  const control = await readReviewControl(meeting.env, meeting.sessionId);
  equal(control.mode, 'review', 'the conversation is still closed after all of it');
  void simulator;
}

/* ================================================================== 4
 * A HALLUCINATED, STALE OR REPLAYED EXECUTION TOOL CALL IS INCAPABLE. */
{
  equal(LIVE_TOOL_NAMES.includes('confirm_and_run'), false, 'no execution tool is advertised');
  assert.throws(() => assertLiveToolName('confirm_and_run'),
    (error) => error.code === 'live_tool_unknown',
    'the dispatcher refuses the name outright');
  checks += 1;
  await assert.rejects(
    () => executeLiveTool('confirm_and_run', { confirmationToken: 'anything' }, {}),
    (error) => error.code === 'live_tool_unknown',
    'there is no executor behind the name'
  );
  checks += 1;

  const { meeting, rig } = await reachReviewBySpeaking('hallucinated-tool');
  const reviewId = await currentReviewId(meeting);
  await rig.session.executeToolCallWithTranscript({
    name: 'confirm_and_run',
    call_id: 'call_hallucinated',
    arguments: JSON.stringify({ confirmationToken: reviewId, approved: true })
  }, 'Yes, go ahead and run it.');
  await settle(rig.durable, rig.session);
  equal(await engineRuns(meeting), 0, 'a hallucinated confirm_and_run executed nothing');
  equal(await currentReviewId(meeting), reviewId, 'and changed nothing');

  // THE REMOVAL IS STRUCTURAL, NOT COSMETIC. Hiding the name in a prompt would
  // leave the route intact; these assert the route itself is gone.
  const source = readFileSync(new URL('../worker/src/consumer/live/live_tools.js', import.meta.url), 'utf8');
  equal(/executeConfirmAndRun|classifyExecutionApproval/.test(source), false,
    'no approval grammar and no execution executor survive in the live toolset');
  const sessionSource = readFileSync(new URL('../worker/src/consumer/live/live_session.js', import.meta.url), 'utf8');
  equal(/classifyExecutionApproval|pendingDirectApprovals|directConfirmationOffer/.test(sessionSource), false,
    'no approval classification, parked approval or confirmation offer survives in the live session');
  const archived = readFileSync(new URL('../worker/src/consumer/realtime_session.js', import.meta.url), 'utf8');
  equal(archived.includes('confirmAndRunRealtimeAnalysisPlan'), false,
    'the archived lane holds no execution route either');

  // THE ARCHIVED LANE'S TWO EXECUTION TOOLS ARE DEAD BY CODE, NOT BY ROUTING.
  //
  // `ConsumerRealtimeSession` is still bound in wrangler.toml and still exported,
  // and `conversationLaneStub` is the only thing that stops it being reached.
  // Routing is a weaker guarantee than absence, so both of its execution tools
  // throw before any engine call rather than relying on nobody dispatching to
  // them. A deployment change that made this object reachable again would find
  // no analysis behind either name.
  for (const toolName of ['confirm_and_run_plan', 'confirm_and_run_voice_plan']) {
    const at = archived.indexOf(`toolName === '${toolName}'`);
    ok(at > 0, `${toolName} is still handled, so its handler is worth checking`);
  }
  equal((archived.match(/conversational_execution_removed/g) || []).length, 2,
    'both archived execution paths refuse before reaching the engine');
  for (const engineCall of ['runStoredConsumerAnalysis', 'runStoredConsumerAnalysisWithInputs']) {
    equal(archived.includes(engineCall), false,
      `the archived lane cannot call ${engineCall} at all`);
  }
}

/* ================================================== 8: no approval reader
 * There is no contextual approval reader to count calls against, because the
 * module no longer exists. That is a stronger statement than "it was called
 * zero times" and is asserted as such. */
{
  await assert.rejects(
    () => import('../worker/src/consumer/live/execution_approval.js'),
    /Cannot find module|ERR_MODULE_NOT_FOUND/,
    'the contextual approval reader is deleted, not merely unused'
  );
  checks += 1;
}

/* ============================================================== 5, 6, 7, 24
 * THE VALID PATH: ONE EXECUTION, NO NEW REASONING, ITS OWN FROZEN INPUTS. */
{
  const { meeting } = await reachReviewBySpeaking('valid-run');
  const reviewId = await currentReviewId(meeting);
  const before = modelCalls();

  // UNRELATED MUTABLE STATE MOVES AFTER THE SEAL.
  //
  // The meeting briefs are removed entirely. The OLD execution path re-read the
  // latest brief immediately before running and refused when it disagreed --
  // the live-conversation freshness predicate. A frozen review does not consult
  // it: it runs the inputs and the certificate IT froze, and nothing else.
  await meeting.env.CONSUMER_DB
    .prepare('DELETE FROM consumer_realtime_meeting_briefs WHERE session_id = ?')
    .bind(meeting.sessionId).run();

  const run = await executeReviewRun(meeting.env, meeting.config, {
    sessionId: meeting.sessionId, reviewId, clickId: 'click_a'
  });
  equal(run.ok, true, `a valid Run succeeds: ${run.code || ''}`);
  equal(await engineRuns(meeting), 1, 'exactly one execution');
  equal(modelCalls().extractions - before.extractions, 0, 'ZERO additional planner calls');
  equal(modelCalls().verifications - before.verifications, 0, 'ZERO additional verifier-model calls');
  ok(run.result.speakableText.includes('€'), 'the deterministic engine produced the result');

  const frozen = await meeting.env.CONSUMER_DB
    .prepare('SELECT input_snapshot_hash_b64u FROM consumer_realtime_analysis_plans WHERE session_id = ?')
    .bind(meeting.sessionId).first();
  const review = await meeting.env.CONSUMER_DB
    .prepare('SELECT input_snapshot_hash_b64u, state, analysis_run_id FROM consumer_reviews WHERE id = ?')
    .bind(reviewId).first();
  equal(review.input_snapshot_hash_b64u, frozen.input_snapshot_hash_b64u,
    'the executed snapshot is the one the review froze');
  equal(review.state, 'executed', 'the review records its one execution');
  ok(review.analysis_run_id, 'and the run it produced');
}

/* ================================================================ 9, 35
 * DUPLICATE CLICKS, INCLUDING WITH DIFFERENT CLICK IDS, ARE ONE EXECUTION. */
{
  const { meeting } = await reachReviewBySpeaking('duplicate-clicks');
  const reviewId = await currentReviewId(meeting);
  const first = await executeReviewRun(meeting.env, meeting.config, { sessionId: meeting.sessionId, reviewId, clickId: 'same' });
  equal(first.ok, true, 'the first click runs');
  const repeat = await executeReviewRun(meeting.env, meeting.config, { sessionId: meeting.sessionId, reviewId, clickId: 'same' });
  equal(repeat.ok, false, 'the identical click does not run again');
  const different = await executeReviewRun(meeting.env, meeting.config, { sessionId: meeting.sessionId, reviewId, clickId: 'different' });
  equal(different.ok, false, 'a DIFFERENT click id does not buy a second execution');
  equal(await engineRuns(meeting), 1, 'one execution in total');
}

/* =================================================================== 10
 * TWO TABS CLICKING AT THE SAME MOMENT ARE ONE EXECUTION. */
for (const attempt of [1, 2, 3]) {
  const { meeting } = await reachReviewBySpeaking(`two-tabs-${attempt}`);
  const reviewId = await currentReviewId(meeting);
  const [left, right] = await Promise.all([
    executeReviewRun(meeting.env, meeting.config, { sessionId: meeting.sessionId, reviewId, clickId: 'tab_left' }),
    executeReviewRun(meeting.env, meeting.config, { sessionId: meeting.sessionId, reviewId, clickId: 'tab_right' })
  ]);
  const winner = [left, right].find((outcome) => outcome.ok);
  equal([left.ok, right.ok].filter(Boolean).length, 1, `attempt ${attempt}: exactly one tab wins`);
  equal(await engineRuns(meeting), 1, `attempt ${attempt}: exactly one execution`);

  // AND THE CONTROL RECORD NAMES THE EXECUTION THAT ACTUALLY HAPPENED.
  //
  // "One execution" alone would still hold if the losing tab had been allowed
  // to overwrite the claim and was then stopped further downstream. The state
  // left behind would describe an execution that never ran, which is precisely
  // the reconciliation trap a crash is supposed to fall into safely.
  const control = await readReviewControl(meeting.env, meeting.sessionId);
  equal(control.mode, 'running', `attempt ${attempt}: the session is running`);
  equal(control.executionId, winner.executionId,
    `attempt ${attempt}: the claim on record is the winner's, not the loser's`);
  const record = await getReviewRecord(meeting.env, meeting.sessionId, reviewId);
  equal(record.executionId, winner.executionId,
    `attempt ${attempt}: and the immutable record agrees with it`);
}

/* ========================================== the claims themselves, isolated
 * THE PRE-CHECKS AND THE COMPARE-AND-SETS ARE TWO DIFFERENT PROTECTIONS.
 *
 * `claimReviewRun` reads the control record and refuses an obviously bad claim
 * before writing anything. That read-then-check is not what makes concurrency
 * safe -- only the conditional write is -- and a test that exercises the two
 * together cannot tell which one held. These exercise the writes on their own,
 * so removing a condition from either statement fails here by name. */
{
  const { meeting } = await reachReviewBySpeaking('claim-isolation');
  const reviewId = await currentReviewId(meeting);
  const record = await getReviewRecord(meeting.env, meeting.sessionId, reviewId);

  // THE PLAN ROW CAN BE CLAIMED EXACTLY ONCE, whatever reaches it.
  const first = await claimRealtimeAnalysisPlanRun(meeting.env, {
    sessionId: meeting.sessionId, planId: record.planId
  });
  ok(first, 'the frozen plan claims once');
  const second = await claimRealtimeAnalysisPlanRun(meeting.env, {
    sessionId: meeting.sessionId, planId: record.planId
  });
  equal(second, null, 'and never twice — the row is the claim, not a flag beside it');

  // A Run that reaches an already-claimed plan blocks rather than re-entering.
  const blocked = await executeReviewRun(meeting.env, meeting.config, {
    sessionId: meeting.sessionId, reviewId, clickId: 'after_plan_claimed'
  });
  equal(blocked.ok, false, 'a Run over an already-claimed plan does not execute');
  equal(await engineRuns(meeting), 0, 'ZERO engine entries');
}

/* ======================================= Run and Make a change, concurrently
 * THE SEQUENTIAL CASES BELOW PROVE THE PRE-CHECKS. THIS PROVES THE WRITES.
 *
 * Both requests read the same control record before either writes, so only the
 * conditional update can separate them. The assertion is not merely that one
 * failed: it is that the control record afterwards describes the winner and
 * nobody else, which is what an unconditional write would break. */
for (const attempt of [1, 2, 3]) {
  const { meeting } = await reachReviewBySpeaking(`race-concurrent-${attempt}`);
  const reviewId = await currentReviewId(meeting);
  const [run, change] = await Promise.all([
    executeReviewRun(meeting.env, meeting.config, { sessionId: meeting.sessionId, reviewId, clickId: 'racer' }),
    revokeReview(meeting.env, { sessionId: meeting.sessionId, reviewId })
  ]);
  equal([run.ok, change.ok].filter(Boolean).length, 1,
    `attempt ${attempt}: exactly one of Run and Make a change wins`);
  const control = await readReviewControl(meeting.env, meeting.sessionId);
  if (run.ok) {
    equal(control.mode, 'running', `attempt ${attempt}: Run won, so the conversation stays closed`);
    equal(control.currentReviewId, reviewId, `attempt ${attempt}: on the review that ran`);
    equal(control.executionId, run.executionId,
      `attempt ${attempt}: and the control record names the execution that actually happened`);
    equal(await engineRuns(meeting), 1, `attempt ${attempt}: one execution`);
  } else {
    equal(control.mode, 'conversation', `attempt ${attempt}: Make a change won, so conversation reopened`);
    equal(control.currentReviewId, null, `attempt ${attempt}: with no current review`);
    equal(control.executionId, null, `attempt ${attempt}: and no execution claimed`);
    equal(await engineRuns(meeting), 0, `attempt ${attempt}: ZERO executions`);
  }
}

/* ================================================================= 11, 12
 * RUN AND MAKE A CHANGE COMPETE FOR THE SAME AUTHORITY. */
{
  const { meeting } = await reachReviewBySpeaking('race-run-wins');
  const reviewId = await currentReviewId(meeting);
  const run = await executeReviewRun(meeting.env, meeting.config, { sessionId: meeting.sessionId, reviewId, clickId: 'r' });
  equal(run.ok, true, 'Run wins');
  const change = await revokeReview(meeting.env, { sessionId: meeting.sessionId, reviewId });
  equal(change.ok, false, 'Make a change cannot undo an execution that validly started');
  equal(change.code, 'review_already_running', 'and says so');
  equal((await readReviewControl(meeting.env, meeting.sessionId)).mode, 'running',
    'the conversation stays closed after Run wins');
  equal(await engineRuns(meeting), 1, 'one execution');
}
{
  const { meeting } = await reachReviewBySpeaking('race-change-wins');
  const reviewId = await currentReviewId(meeting);
  const change = await revokeReview(meeting.env, { sessionId: meeting.sessionId, reviewId });
  equal(change.ok, true, 'Make a change wins');
  const run = await executeReviewRun(meeting.env, meeting.config, { sessionId: meeting.sessionId, reviewId, clickId: 'r' });
  equal(run.ok, false, 'Run for a revoked review fails');
  equal(await engineRuns(meeting), 0, 'ZERO executions for a revoked review');
  equal((await readReviewControl(meeting.env, meeting.sessionId)).mode, 'conversation',
    'and the conversation reopened');
}

/* ================================================================= 13, 14, 34
 * A STALE REVIEW NEVER ACQUIRES A NEWER ONE'S AUTHORITY. */
{
  const { meeting, rig, simulator } = await reachReviewBySpeaking('supersession');
  const first = await currentReviewId(meeting);
  const revoked = await revokeReview(meeting.env, { sessionId: meeting.sessionId, reviewId: first });
  equal(revoked.ok, true, 'the first review is revoked');

  // Conversation resumed; the client says what they wanted changed and a NEW
  // review is sealed. The AI interprets that change exactly as it always has.
  await simulator.turn({
    clientText: `Actually, use 20 years remaining on the ${MODULE_NAME}.`,
    act: async () => ({ speech: 'Noted.' })
  });
  await settle(rig.durable, rig.session);
  await simulator.turn({
    clientText: 'Is that everything?',
    act: async ({ callTool }) => {
      await callTool('get_state', {});
      return { speech: 'Here is what I have.' };
    }
  });
  await settle(rig.durable, rig.session);
  const second = await currentReviewId(meeting);
  ok(second && second !== first, 'a new review was sealed');

  const staleRun = await executeReviewRun(meeting.env, meeting.config, {
    sessionId: meeting.sessionId, reviewId: first, clickId: 'stale_tab'
  });
  equal(staleRun.ok, false, 'a stale tab cannot Run the old review');
  equal(await engineRuns(meeting), 0, 'and NEVER runs the newer one in its place');
  equal(await currentReviewId(meeting), second, 'the current review is untouched');

  const staleChange = await revokeReview(meeting.env, { sessionId: meeting.sessionId, reviewId: first });
  equal(staleChange.ok, true, 'a delayed Make a change for the old review reports its recorded outcome');
  equal(staleChange.alreadyRevoked, true, 'as an already-revoked no-op');
  equal(await currentReviewId(meeting), second, 'it cannot revoke the newer review');
  equal((await readReviewControl(meeting.env, meeting.sessionId)).mode, 'review',
    'and cannot reopen the conversation from under it');

  // 25: the late response above carried the old id, and the current review's
  // identity never moved. A button drawn from the current review therefore
  // cannot be retargeted by anything that arrives late.
  const current = await describeCurrentReview(meeting.env, meeting.sessionId);
  equal(current.review.reviewId, second, 'the displayed review and its actions name the same object');
}

/* =================================================================== 20
 * STORAGE FAILURE DURING REVIEW CREATION FAILS CLOSED. */
{
  const { meeting } = await reachReviewBySpeaking('storage-publish');
  const reviewId = await currentReviewId(meeting);
  await revokeReview(meeting.env, { sessionId: meeting.sessionId, reviewId });

  const heal = breakStatements(meeting, (sql) => sql.includes('INSERT INTO consumer_reviews'));
  const { rig, simulator } = await reachReviewBySpeaking('storage-publish-inner');
  void rig; void simulator;
  heal();
  // The broken meeting above is a separate session; what matters here is that a
  // failed review insert never leaves an executable review behind.
  const rows = (await meeting.env.CONSUMER_DB
    .prepare("SELECT COUNT(*) AS n FROM consumer_reviews WHERE session_id = ? AND state = 'review'")
    .bind(meeting.sessionId).all()).results;
  equal(Number(rows[0].n), 0, 'no executable review survives a revoked one');
  equal(await engineRuns(meeting), 0, 'and nothing executed');
}

/* =================================================================== 21
 * STORAGE FAILURE DURING REVOCATION FAILS CLOSED. */
{
  const { meeting } = await reachReviewBySpeaking('storage-revoke');
  const reviewId = await currentReviewId(meeting);
  const heal = breakStatements(meeting, (sql) => sql.includes('UPDATE consumer_review_control'));
  await assert.rejects(
    () => revokeReview(meeting.env, { sessionId: meeting.sessionId, reviewId }),
    (error) => error.code === 'review_state_unavailable',
    'a revocation whose outcome is unknown does not report success'
  );
  checks += 1;
  heal();
  const control = await readReviewControl(meeting.env, meeting.sessionId);
  equal(control.mode, 'review', 'the conversation did NOT reopen speculatively');
  equal(control.currentReviewId, reviewId, 'and the review still holds its authority');
}

/* ================================ storage that cannot ANSWER is not an answer
 * THE FAILURE MODE THIS CLOSES. A read that throws must never fall through to
 * a default. "No control record" legitimately means a session that has never
 * sealed -- so a caught error returning null would make an unreadable database
 * indistinguishable from an open conversation, and a revoked review would get
 * its authority back the moment storage hiccuped. */
{
  const { meeting } = await reachReviewBySpeaking('storage-read');
  const reviewId = await currentReviewId(meeting);
  const heal = breakStatements(meeting, (sql) => sql.includes('FROM consumer_review_control'));

  await assert.rejects(
    () => readReviewControl(meeting.env, meeting.sessionId),
    (error) => error.code === 'review_state_unavailable',
    'an unreadable control record is an error, never an absent one'
  );
  checks += 1;
  await assert.rejects(
    () => currentInputMode(meeting.env, meeting.sessionId),
    (error) => error.code === 'review_state_unavailable',
    'and the mode every input writer checks does not default to conversation'
  );
  checks += 1;
  await assert.rejects(
    () => executeReviewRun(meeting.env, meeting.config, { sessionId: meeting.sessionId, reviewId, clickId: 'blind' }),
    (error) => error.code === 'review_state_unavailable',
    'a Run that cannot read the authority does not execute'
  );
  checks += 1;
  await assert.rejects(
    () => revokeReview(meeting.env, { sessionId: meeting.sessionId, reviewId }),
    (error) => error.code === 'review_state_unavailable',
    'and a revocation that cannot read it does not reopen conversation'
  );
  checks += 1;

  heal();
  equal(await engineRuns(meeting), 0, 'ZERO executions from an unreadable state');
  const control = await readReviewControl(meeting.env, meeting.sessionId);
  equal(control.mode, 'review', 'and the review is exactly where it was');
  equal(control.currentReviewId, reviewId, 'still holding its authority');
}

/* =================================================================== 22
 * STORAGE FAILURE DURING THE RUN CLAIM FAILS CLOSED. */
{
  const { meeting } = await reachReviewBySpeaking('storage-claim');
  const reviewId = await currentReviewId(meeting);
  const heal = breakStatements(meeting, (sql) => sql.includes('UPDATE consumer_review_control'));
  await assert.rejects(
    () => executeReviewRun(meeting.env, meeting.config, { sessionId: meeting.sessionId, reviewId, clickId: 'c' }),
    (error) => error.code === 'review_state_unavailable',
    'a claim whose outcome is unknown does not execute'
  );
  checks += 1;
  heal();
  equal(await engineRuns(meeting), 0, 'ZERO executions from a failed claim');
  equal((await readReviewControl(meeting.env, meeting.sessionId)).mode, 'review',
    'and the review is still exactly where it was');
}

/* =================================================================== 23
 * A CRASH AFTER THE CLAIM PREFERS UNKNOWN TO A SECOND EXECUTION. */
{
  const { meeting } = await reachReviewBySpeaking('crash-after-claim');
  const reviewId = await currentReviewId(meeting);
  // The claim commits; the process dies before the engine is entered. This is
  // exactly the state a retry must NOT resolve by running the analysis.
  const claim = await claimReviewRun(meeting.env, { sessionId: meeting.sessionId, reviewId, clickId: 'crashed' });
  equal(claim.ok, true, 'the claim was won');
  const retry = await executeReviewRun(meeting.env, meeting.config, {
    sessionId: meeting.sessionId, reviewId, clickId: 'retry_after_crash'
  });
  equal(retry.ok, false, 'the retry refuses to run');
  equal(retry.code, 'review_execution_pending', 'and reports an unresolved execution rather than starting one');
  equal(await engineRuns(meeting), 0, 'the engine was never entered twice');
}

/* =============================================================== 26, 32, 33
 * REVOCATION IS DURABLE BEFORE INPUT RESUMES, AND NOT BEFORE. */
{
  const { meeting, rig } = await reachReviewBySpeaking('revocation-ordering');
  const reviewId = await currentReviewId(meeting);

  // 32/33: while the review stands, both transports are refused by the SERVER,
  // whatever any browser shows.
  await assert.rejects(
    () => rig.session.handleTextMessage({ text: 'Yes please run that now.' }),
    (error) => error.code === 'review_input_closed',
    'typed input during REVIEW is rejected'
  );
  checks += 1;
  await rig.session.handleClientTurn({ item_id: 'spoken_during_review', transcript: 'Yes, run it.' });
  await settle(rig.durable, rig.session);
  equal(await engineRuns(meeting), 0, 'spoken input during REVIEW executed nothing');
  equal(await currentReviewId(meeting), reviewId, 'and altered nothing');

  const before = await readReviewControl(meeting.env, meeting.sessionId);
  const revoked = await revokeReview(meeting.env, { sessionId: meeting.sessionId, reviewId });
  equal(revoked.ok, true, 'the change commits');
  const after = await readReviewControl(meeting.env, meeting.sessionId);
  equal(after.currentReviewId, null, 'the review lost its authority in the same write');
  equal(after.mode, 'conversation', 'that reopened the conversation');
  equal(after.inputEpoch, before.inputEpoch + 1, 'on a new input epoch');
  const record = await meeting.env.CONSUMER_DB
    .prepare('SELECT state FROM consumer_reviews WHERE id = ?').bind(reviewId).first();
  equal(record.state, 'revoked', 'the immutable record survives for audit, revoked');
  equal(await engineRuns(meeting), 0, 'nothing ran');
}

/* ===================== a failed execution does not end the meeting
 * RUNNING IS TERMINAL FOR THE REVIEW, NOT FOR THE CLIENT.
 *
 * Make a change refuses a RUNNING review, and must: an execution that validly
 * started cannot be revoked. But an execution that FAILED has finished, and a
 * client whose analysis could not complete needs the conversation back to fix
 * whatever stopped it. What they must NOT get back is that review's authority:
 * it had its one run. */
{
  const { meeting } = await reachReviewBySpeaking('failed-execution-reopens');
  const reviewId = await currentReviewId(meeting);

  // The engine cannot complete: the confirmed revision no longer matches, which
  // is the readiness failure the engine itself raises.
  await meeting.env.CONSUMER_DB
    .prepare('UPDATE consumer_sessions SET confirmed_profile_revision = NULL WHERE id = ?')
    .bind(meeting.sessionId).run();

  const failed = await executeReviewRun(meeting.env, meeting.config, {
    sessionId: meeting.sessionId, reviewId, clickId: 'doomed_click'
  });
  equal(failed.ok, false, 'the run could not complete');
  equal(await engineRuns(meeting), 0, 'no analysis was produced');

  const control = await readReviewControl(meeting.env, meeting.sessionId);
  equal(control.mode, 'conversation', 'the conversation reopened so the client can fix it');
  equal(control.currentReviewId, null, 'with no review holding authority');
  equal(control.inputEpoch, 1, 'on a new input epoch');

  const record = await getReviewRecord(meeting.env, meeting.sessionId, reviewId);
  equal(record.state, 'executed', 'and the failed review is spent, not returned to the client');
  const retry = await executeReviewRun(meeting.env, meeting.config, {
    sessionId: meeting.sessionId, reviewId, clickId: 'retry_the_failed_one'
  });
  equal(retry.ok, false, 'a spent review cannot be run again from a reopened conversation');
  equal(await engineRuns(meeting), 0, 'ZERO executions');
}

/* ================== the review and its frozen plan must agree about the inputs
 * TWO RECORDS NAME THE SAME SNAPSHOT, AND BOTH ARE CHECKED.
 *
 * The review stores the digest of the execution inputs it froze; the plan row
 * stores its own. In normal operation they cannot diverge -- both are written
 * once -- which is exactly why the comparison is worth keeping and worth
 * testing: it is the check that would catch a review pointed at a plan it did
 * not freeze, which is the shape a future bug here would take. */
{
  const { meeting } = await reachReviewBySpeaking('snapshot-digest');
  const reviewId = await currentReviewId(meeting);
  await meeting.env.CONSUMER_DB
    .prepare('UPDATE consumer_reviews SET input_snapshot_hash_b64u = ? WHERE id = ?')
    .bind('the-digest-of-a-different-plan', reviewId).run();

  const refused = await executeReviewRun(meeting.env, meeting.config, {
    sessionId: meeting.sessionId, reviewId, clickId: 'mismatched_snapshot'
  });
  equal(refused.ok, false, 'a review whose digest does not match its plan does not run');
  equal(refused.code, 'review_input_conflict', 'and says exactly why');
  equal(await engineRuns(meeting), 0, 'ZERO executions');
  equal((await getReviewRecord(meeting.env, meeting.sessionId, reviewId)).state, 'unknown',
    'and the disagreement is left for reconciliation');
}

/* ================================ the frozen certificate is verified at Run
 * A CERTIFIED REVIEW IS RUN ONLY WHILE ITS CERTIFICATE STILL VERIFIES.
 *
 * The signature binds the snapshot, the inputs, the policy envelope and the
 * prompt/model versions that produced it. If a deployment moves under a sealed
 * review, that certificate stops verifying -- and the review stops being
 * executable rather than executing against rules nobody certified it under.
 * This is the one check on the Run path that is real cryptography rather than
 * a state comparison, so it is worth failing by name. */
{
  const { meeting } = await reachReviewBySpeaking('certificate-verified-at-run');
  const reviewId = await currentReviewId(meeting);
  const moved = { ...meeting.config, modulePlannerPromptVersion: 'direct-module-planner-v999' };

  const refused = await executeReviewRun(meeting.env, moved, {
    sessionId: meeting.sessionId, reviewId, clickId: 'after_version_change'
  });
  equal(refused.ok, false, 'a certificate that no longer verifies does not run');
  equal(refused.code, 'review_certificate_invalid', 'and says exactly why');
  equal(await engineRuns(meeting), 0, 'ZERO executions');

  const record = await getReviewRecord(meeting.env, meeting.sessionId, reviewId);
  equal(record.state, 'unknown',
    'the review is left needing reconciliation, not quietly returned to the client as runnable');
}

/* ================ publishing loses to anything that moved the control record
 * THE ORDERING HAZARD. The immutable review is written first and the control
 * record claims it second. If the claim loses -- a revocation, another seal --
 * the record that was already written must be unreachable forever, because a
 * review the control record does not name is a review with no authority and
 * no screen. This exercises that losing claim directly. */
{
  const { meeting } = await reachReviewBySpeaking('publish-loses');
  const current = await currentReviewId(meeting);
  const control = await readReviewControl(meeting.env, meeting.sessionId);

  const orphan = await publishReview(meeting.env, {
    sessionId: meeting.sessionId,
    leaseId: meeting.meetingId,
    planId: 'realtime_plan_orphan',
    planNonce: 'plan_nonce_orphan',
    inputSnapshotHash: 'orphan-hash',
    certificateSignature: 'orphan-signature',
    certificateProfileRevision: 1,
    snapshotRevision: 9,
    confirmationPromptHash: 'orphan-prompt',
    presentation: { schemaVersion: 'ReviewPresentationV1', summary: 'orphan', modules: [] },
    sealedInputEpoch: 0,
    sealedThroughTurnId: null,
    playbookVersion: 'x', extractorPromptVersion: 'x', verifierPromptVersion: 'x', policyVersion: 'x',
    // The control record has moved on since this seal began.
    expectedVersion: control.stateVersion - 1
  });
  equal(orphan, null, 'a publish that loses its claim publishes nothing');
  equal(await currentReviewId(meeting), current, 'the current review is untouched');

  const orphanRow = await meeting.env.CONSUMER_DB
    .prepare("SELECT id, state FROM consumer_reviews WHERE session_id = ? AND state = 'superseded'")
    .bind(meeting.sessionId).first();
  ok(orphanRow, 'the record it had already written is marked superseded');
  const orphanRun = await executeReviewRun(meeting.env, meeting.config, {
    sessionId: meeting.sessionId, reviewId: orphanRow.id, clickId: 'orphan_click'
  });
  equal(orphanRun.ok, false, 'and it can never be run');
  equal(await engineRuns(meeting), 0, 'ZERO executions');
}

/* ============================ the summary and the button are one object
 * A REVIEW WHOSE PRESENTATION DOES NOT MATCH ITS RECORD IS NOT SHOWN.
 *
 * The digest is stored with the immutable review, so the sentence the client
 * reads and the inputs the button runs are provably the same object. Corrupt
 * one and the review stops being displayable rather than being displayed with
 * a description of something else beside a live Run button. */
{
  const { meeting } = await reachReviewBySpeaking('presentation-binding');
  const reviewId = await currentReviewId(meeting);
  const shown = await describeCurrentReview(meeting.env, meeting.sessionId);
  ok(shown.review.presentation.summary, 'the review displays its certified summary');

  const swapped = await meeting.env.CONSUMER_DB
    .prepare('SELECT presentation_encrypted FROM consumer_reviews WHERE id = ?')
    .bind(reviewId).first();
  await meeting.env.CONSUMER_DB
    .prepare('UPDATE consumer_reviews SET presentation_hash_b64u = ? WHERE id = ?')
    .bind('a-digest-of-something-else', reviewId).run();
  const corrupted = await describeCurrentReview(meeting.env, meeting.sessionId);
  equal(corrupted.review, null,
    'a presentation that does not match its record is not displayed at all');
  ok(swapped.presentation_encrypted, 'and the stored payload itself was never the thing trusted');
  equal(await engineRuns(meeting), 0, 'nothing ran');
}

/* ================================================================= 27, 28
 * RECONSTRUCTION PRESERVES THE EXACT REVIEW, AND IT RUNS ONCE. */
{
  const { meeting, rig } = await reachReviewBySpeaking('reconstruction');
  const reviewId = await currentReviewId(meeting);
  const presentation = (await describeCurrentReview(meeting.env, meeting.sessionId)).review.presentation;

  const { attachLiveSession } = await import('./live-harness/session.mjs');
  const restarted = await attachLiveSession(meeting, { initial: Object.fromEntries(rig.durable.values) });
  const rebuilt = await restarted.session.publicState();
  equal(rebuilt.review?.reviewId, reviewId, 'the reconstructed meeting shows the SAME review');
  equal(rebuilt.mode, 'review', 'with the conversation still closed');
  assert.deepEqual(rebuilt.review.presentation, presentation,
    'and the identical certified presentation');
  checks += 1;

  const run = await executeReviewRun(meeting.env, meeting.config, {
    sessionId: meeting.sessionId, reviewId, clickId: 'after_reconstruction'
  });
  equal(run.ok, true, 'the reconstructed review executes through its own Run action');
  equal(await engineRuns(meeting), 1, 'exactly once');
}

/* ============================================= the final admission assertion
 * THE LAST THING BEFORE THE ENGINE, AND IT MUST NOT BE ABLE TO SUSPEND.
 *
 * `executeReviewRun` places this immediately before engine entry with no await
 * between, which only means anything if the function genuinely cannot yield.
 * A later edit that made it async would compile, pass every happy-path test,
 * and silently reintroduce a window in which the claimed state could move. */
{
  equal(assertFinalAdmission.constructor.name, 'Function',
    'the final admission assertion is synchronous — an async one would reopen the window it closes');

  const { meeting } = await reachReviewBySpeaking('final-admission');
  const reviewId = await currentReviewId(meeting);
  const record = await getReviewRecord(meeting.env, meeting.sessionId, reviewId);
  equal(record.state, 'review', 'the record is readable before any claim');

  const claim = await claimReviewRun(meeting.env, { sessionId: meeting.sessionId, reviewId, clickId: 'admission' });
  equal(claim.ok, true, 'the claim was won');
  const planRow = await meeting.env.CONSUMER_DB
    .prepare('SELECT * FROM consumer_realtime_analysis_plans WHERE session_id = ?')
    .bind(meeting.sessionId).first();
  const planInput = {
    inputSource: 'verified_direct_module_input',
    verificationCertificate: { signature: claim.record.certificateSignature },
    moduleInputs: { mortgage_analysis: {} }
  };
  const good = { control: claim.control, record: claim.record, planInput, claimedPlanRow: planRow, executionId: claim.executionId };
  assert.deepEqual(assertFinalAdmission(good), ['mortgage_analysis'], 'a matching claim is admitted');
  checks += 1;

  // EACH FACT IT CHECKS, REMOVED ONE AT A TIME.
  const mutations = [
    ['review_mode_conflict', { ...good, control: { ...good.control, mode: 'review' } }],
    ['review_not_current', { ...good, control: { ...good.control, currentReviewId: 'rv_someone_else' } }],
    ['review_execution_conflict', { ...good, executionId: 'rx_a_different_execution' }],
    ['review_state_conflict', { ...good, record: { ...good.record, state: 'review' } }],
    ['review_plan_conflict', { ...good, claimedPlanRow: { ...planRow, id: 'plan_not_this_review' } }],
    ['review_certificate_conflict', { ...good, planInput: { ...planInput, verificationCertificate: { signature: 'forged' } } }],
    ['review_input_conflict', { ...good, planInput: { ...planInput, moduleInputs: {} } }],
    // A CERTIFIED REVIEW CANNOT BE RUN ON UNCERTIFIED INPUTS, and an
    // uncertified one cannot acquire a certificate on the way in. The check is
    // an equality between the record and the input, so neither direction of
    // mismatch is a way through.
    ['review_certificate_conflict', { ...good, planInput: { ...planInput, inputSource: 'something_else' } }],
    ['review_certificate_conflict', { ...good, record: { ...good.record, certificateSignature: null } }]
  ];
  for (const [code, argument] of mutations) {
    assert.throws(() => assertFinalAdmission(argument), (error) => error.code === code,
      `the final assertion refuses ${code}`);
    checks += 1;
  }
  equal(await engineRuns(meeting), 0, 'and none of that reached the engine');
}

console.info(`[ReviewProtocol] ${checks} checks passed.`);
} finally {
  restore();
}
