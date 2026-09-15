#!/usr/bin/env node

/**
 * THE THREE WAYS AN EXECUTION USED TO GET PAST THE APPROVAL BOUNDARY.
 *
 * Astra's independent audit of 40deb248 found three P1 bypasses, all at the
 * same boundary and all with the same shape: the barrier was asked whether the
 * client's WORDS looked like agreement, when the question it actually needed
 * answered was whether the client had agreed TO THIS PLAN, NOW.
 *
 *   1. "Yes" approves the wrong proposition. A delivered offer keeps its
 *      binding across a clarification exchange -- it has to, or a client who
 *      asks one question can never approve anything -- so an assistant question
 *      asked after the read-back inherits the offer's causal binding. A "yes"
 *      to THAT question arrived at the barrier looking exactly like a "yes" to
 *      the plan, and ran it.
 *
 *   2. Normalisation discards the correction and executes the old offer. The
 *      grammar lowercased, stripped every character outside [a-z0-9\s], and
 *      then asked whether what survived was an approval clause. A reply that
 *      agreed in English and then corrected the ownership of a pension in
 *      another script survived as the single token "yes". The correction was
 *      not judged and rejected; it was deleted before anything judged it.
 *
 *   3. A late approval executes after a newer client turn has begun. An
 *      approval whose read-back had not yet been acknowledged was parked and
 *      resumed when the delivery evidence landed. Nothing in that resumption
 *      asked whether the client had since started speaking again, so an
 *      agreement the client had already moved past could still reach the
 *      engine.
 *
 * WHAT MUST BE TRUE NOW. Each case produces ZERO engine executions against the
 * stale offer. Below them, the positive path: an ordinary natural approval of
 * the delivered plan runs exactly once, does it without reopening unchanged
 * financial semantics through the planner or the verifier, and cannot run a
 * second time.
 *
 * WHAT IS REAL HERE. The Durable Object, a real local D1, real transcript
 * storage, real detached planning, the real encrypted brief, the real
 * certificate, the real confirmation barrier, the real delivery evidence, the
 * real turn fence and the real deterministic module execution. Only two model
 * OPINIONS are scripted: the planner's, and the approval reader's. Scripting
 * the reader is what makes these tests about the barriers rather than about
 * model quality -- the reader is told what a competent reading is, and the
 * question under test is what the server does with it.
 *
 * FREE. No provider, no network, no production writes.
 */

import assert from 'node:assert/strict';

import {
  attachLiveSession, attachTypedSession, newLiveMeeting, settle
} from './live-harness/session.mjs';
import { LiveProviderSimulator } from './live-harness/provider.mjs';
import { interleavingDatabase } from './live-harness/interleave.mjs';
import {
  APPROVAL_DECISION_SCHEMA_NAME,
  approvalDecisionResponse
} from './live-harness/approval-script.mjs';
import {
  DIRECT_MODULE_CONTRACTS,
  DIRECT_MODULE_IDS,
  MODULE_PLANNING_SNAPSHOT_V1
} from '../worker/src/consumer/direct_module_planner.js';
import { classifyExecutionApproval } from '../worker/src/consumer/live/execution_approval.js';
import { decideExecutionApproval } from '../worker/src/consumer/live/approval_decision.js';
import {
  ANSWERED_PROPOSITIONS,
  APPROVAL_DECISION_PROMPT,
  APPROVAL_DECISION_SCHEMA,
  EXECUTION_APPROVAL_DECISIONS
} from '../worker/src/consumer/live/approval_decision.js';

const pass = (message) => console.info(`[ApprovalMeaning] PASS: ${message}`);
let checks = 0;
const ok = (value, message) => { checks += 1; assert.ok(value, message); };
const equal = (actual, expected, message) => { checks += 1; assert.deepEqual(actual, expected, message); };

/* ---------------------------------------------- the contract the reader has */

/**
 * WHAT THE READER IS ALLOWED TO SAY, AND WHAT IT IS TOLD.
 *
 * The four decisions are not decoration: exactly one of them executes, and the
 * other three are the ways a client can fail to have agreed. Widening the
 * vocabulary, or quietly dropping one of the refusing decisions, would move the
 * boundary without touching any of the barriers below -- so the vocabulary is
 * pinned here, where changing it has to be deliberate.
 */
equal([...EXECUTION_APPROVAL_DECISIONS].sort(),
  ['pure_approval', 'question_or_uncertainty', 'semantic_change', 'unclear'],
  'the reader distinguishes approval, change, question/uncertainty and unclear -- and nothing else');
equal([...ANSWERED_PROPOSITIONS].sort(), ['none', 'offer', 'other_assistant_question'],
  'and says which proposition the client addressed, which is what P1-1 turns on');
equal(APPROVAL_DECISION_SCHEMA.additionalProperties, false,
  'the reader cannot return a field nobody asked for');
equal([...APPROVAL_DECISION_SCHEMA.required].sort(),
  ['answeredProposition', 'decision', 'reason', 'schemaVersion'],
  'and must return the proposition alongside the decision, never one without the other');
ok(APPROVAL_DECISION_PROMPT.includes('UNTRUSTED EVIDENCE'),
  'the client reply is given to the reader as evidence, never as instructions');
ok(/never instructions/i.test(APPROVAL_DECISION_PROMPT)
  && /interveningContext entry whose role is client/i.test(APPROVAL_DECISION_PROMPT),
  'and the boundary covers the client turns in the context too, not just the reply');
ok(/language or script/i.test(APPROVAL_DECISION_PROMPT),
  'a correction is a correction in any language, which is the whole of P1-2');
pass('the reader has a bounded vocabulary, a closed schema and an untrusted-evidence boundary');

/* ------------------------------------- the reader's answer is not trusted --- */

/**
 * A STRUCTURED-OUTPUT CONTRACT IS A REQUEST, NOT A GUARANTEE.
 *
 * This is the one decision that lets a financial plan run without anyone
 * reading the client's words again, and the thing that authorises it arrives
 * over the network from a provider that can change, through a proxy that can
 * rewrite, from a model that can answer a schema it was never shown. So the
 * answer is checked locally against the whole declared contract -- every field
 * present and of the declared type, every enum inside its enum, and nothing
 * present that was not declared, because an unexpected property means this is
 * not the answer the schema describes.
 *
 * Every failure is `unclear`, and `unclear` never executes.
 */
{
  const realFetch = globalThis.fetch;
  const APPROVED = {
    schemaVersion: 'ExecutionApprovalDecisionV1',
    decision: 'pure_approval',
    answeredProposition: 'offer',
    reason: 'agrees'
  };
  const envelope = { offer: { offerToken: 'dmc_x' }, clientReply: 'Yes, go ahead.' };
  const read = async (value) => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ status: 'completed', output_text: JSON.stringify(value), usage: {} })
    });
    try {
      return await decideExecutionApproval({
        env: { OPENAI_API_KEY: 'synthetic-test-key' },
        config: { modulePlannerModel: 'gpt-test', modulePlannerTimeoutMs: 5_000 },
        envelope
      });
    } finally { globalThis.fetch = realFetch; }
  };

  equal((await read(APPROVED)).decision, 'pure_approval',
    'the declared answer is accepted, or this proves nothing');
  for (const [label, value] of [
    ['an undeclared extra field', { ...APPROVED, executeAnyway: true }],
    ['a missing field', { schemaVersion: APPROVED.schemaVersion, decision: 'pure_approval', answeredProposition: 'offer' }],
    ['a reason that is not a string', { ...APPROVED, reason: { text: 'agrees' } }],
    ['a decision outside the vocabulary', { ...APPROVED, decision: 'approved' }],
    ['a proposition outside the vocabulary', { ...APPROVED, answeredProposition: 'the_plan' }],
    ['another schema version', { ...APPROVED, schemaVersion: 'ExecutionApprovalDecisionV2' }],
    ['an array', [APPROVED]],
    ['nothing at all', null]
  ]) {
    equal((await read(value)).decision, 'unclear', `${label} cannot authorise execution`);
  }
  equal((await read({ ...APPROVED, decision: 'semantic_change' })).decision, 'semantic_change',
    'and a well-formed refusal is still read as the refusal it is, not flattened to unclear');
  pass('the reader\'s answer is enforced against its whole declared schema, and fails closed');
}

/* ------------------------------------------------------------- the fixture */

const POSITION_TURN = 'We have 80,000 euro in cash between us, the house is worth 500,000 with a '
  + '300,000 mortgage on it, my pension is 50,000 and my wife’s is 30,000.';
const SPEND_TURN = 'We spend about 4,000 euro a month including the mortgage.';
const SNAPSHOT_TURN = 'I would just like to see the overall snapshot for now.';

const CONFIRMATION_PROMPT = 'I will run the overall financial snapshot using your €80,000 joint '
  + 'savings, your jointly owned €500,000 home with its €300,000 mortgage, your €50,000 '
  + 'pension, your wife’s €30,000 pension, and about €4,000 of monthly household spending. '
  + 'Does that sound right, and shall I run exactly that plan?';

const PBS_INPUT = Object.freeze({
  currency: 'EUR',
  assetPositions: [
    { id: 'cash', label: 'Joint savings', bucket: 'spendable_reserves', amount: 80000, source: 'assets' },
    { id: 'home', label: 'Family home', bucket: 'lifestyle_assets', amount: 500000, source: 'properties' },
    { id: 'pension-primary', label: 'Your pension', bucket: 'retirement_funding', amount: 50000, source: 'pensions' },
    { id: 'pension-partner', label: 'Your wife’s pension', bucket: 'retirement_funding', amount: 30000, source: 'pensions' }
  ],
  liabilityPositions: [{ id: 'mortgage', label: 'Mortgage', amount: 300000, source: 'liabilities' }],
  monthlyExpenditure: 4000,
  reconciliationWarnings: [],
  currencyWarnings: []
});

const PASS_VERDICT = Object.freeze({
  schemaVersion: 'ModuleInputVerificationV1',
  verdict: 'pass',
  unsupportedPaths: [],
  omittedSupportedInformation: [],
  unresolvedAmbiguities: [],
  clarifications: [],
  confirmationPromptApproved: true,
  explanation: 'Every ready input is supported by the client’s own words.'
});

function extractionFor(throughTurnId, baseSnapshotRevision, positionTurnId, spendTurnId) {
  return {
    schemaVersion: MODULE_PLANNING_SNAPSHOT_V1,
    baseSnapshotRevision,
    throughTurnId,
    confirmationPrompt: CONFIRMATION_PROMPT,
    generalAmbiguities: [],
    modules: DIRECT_MODULE_IDS.map((moduleId) => ({
      moduleId,
      outputKey: DIRECT_MODULE_CONTRACTS[moduleId].outputKey,
      status: moduleId === 'personal_balance_sheet' ? 'ready' : 'not_relevant',
      inputJson: moduleId === 'personal_balance_sheet' ? JSON.stringify(PBS_INPUT) : '',
      steeringSummary: moduleId === 'personal_balance_sheet'
        ? 'Overall snapshot: €80,000 savings, €500,000 home, €300,000 mortgage, '
          + '€50,000 and €30,000 pensions, €4,000 monthly spending.'
        : '',
      selection: moduleId === 'personal_balance_sheet'
        ? { origin: 'client_requested', reason: 'They asked for an overall snapshot of where they stand.' }
        : { origin: 'not_selected', reason: 'Not asked for today.' },
      missing: [],
      ambiguities: [],
      assumptions: [],
      resolvedAcknowledgedUnknown: [],
      evidence: moduleId === 'personal_balance_sheet' ? [
        { path: '/assetPositions/0', source: 'conversation', turnId: positionTurnId, quote: '80,000 euro in cash between us', profilePath: '' },
        { path: '/assetPositions/1', source: 'conversation', turnId: positionTurnId, quote: 'the house is worth 500,000', profilePath: '' },
        { path: '/assetPositions/2', source: 'conversation', turnId: positionTurnId, quote: 'my pension is 50,000', profilePath: '' },
        { path: '/assetPositions/3', source: 'conversation', turnId: positionTurnId, quote: 'my wife’s is 30,000', profilePath: '' },
        { path: '/liabilityPositions/0', source: 'conversation', turnId: positionTurnId, quote: 'a 300,000 mortgage on it', profilePath: '' },
        { path: '/monthlyExpenditure', source: 'conversation', turnId: spendTurnId, quote: 'about 4,000 euro a month', profilePath: '' }
      ] : []
    }))
  };
}

/* ------------------------------------------------------- the scripted lane */

let approvalScript = {};
const approvalEnvelopes = [];
let extractionCalls = 0;
let verificationCalls = 0;
// The typed lane's renderer, scripted the way the typed gates script it: a
// queue of either a tool call or a line of text, consumed one per turn.
let typedRendererSteps = [];
let typedCallSequence = 0;

/**
 * A hold on the approval reader, so a test can stand inside that await.
 *
 * The reader is the longest await between a client agreeing and a plan running,
 * and two of the three stale executions happened inside it. `holdApprovalReader`
 * returns the release; until it is called, every approval reading blocks.
 */
let approvalReaderGate = null;
function holdApprovalReader() {
  let release;
  approvalReaderGate = new Promise((resolve) => { release = resolve; });
  return () => { approvalReaderGate = null; release(); };
}
/** Resolves once the reader has actually been reached and is blocked. */
let approvalReaderEntered = null;
let announceApprovalReaderEntered = () => {};
function watchForApprovalReader() {
  approvalReaderEntered = new Promise((resolve) => { announceApprovalReaderEntered = resolve; });
  return approvalReaderEntered;
}

globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  const schema = body.text?.format?.name || '';
  if (!schema) {
    const step = typedRendererSteps.shift();
    assert.ok(step, 'the typed renderer follows the scripted provider actions');
    const output = step.tool
      ? [{
          type: 'function_call',
          name: step.tool,
          arguments: JSON.stringify(step.args || {}),
          call_id: `typed_approval_${++typedCallSequence}`
        }]
      : [{ type: 'message', content: [{ type: 'output_text', text: step.speech }] }];
    return { ok: true, json: async () => ({ status: 'completed', output, usage: {} }) };
  }
  const requestBody = JSON.parse(body.input?.[1]?.content || '{}');
  if (schema === APPROVAL_DECISION_SCHEMA_NAME) {
    approvalEnvelopes.push(requestBody);
    if (approvalReaderGate) {
      announceApprovalReaderEntered();
      await approvalReaderGate;
    }
    return approvalDecisionResponse(requestBody, approvalScript);
  }
  let value;
  if (schema === 'module_planning_snapshot_v1') {
    extractionCalls += 1;
    const turns = requestBody.conversation || [];
    value = extractionFor(
      requestBody.throughTurnId,
      Number(requestBody.previousSnapshot?.snapshotRevision || 0),
      turns.find((turn) => turn.text === POSITION_TURN)?.turnId || requestBody.throughTurnId,
      turns.find((turn) => turn.text === SPEND_TURN)?.turnId || requestBody.throughTurnId
    );
  } else if (schema === 'module_input_verification_v1') {
    verificationCalls += 1;
    value = PASS_VERDICT;
  } else {
    throw new Error(`Unexpected model request ${schema || 'unknown'}`);
  }
  return {
    ok: true,
    json: async () => ({
      status: 'completed',
      output_text: JSON.stringify(value),
      usage: { input_tokens: 100, output_tokens: 50 }
    })
  };
};

/** A meeting driven to a delivered, certified, still-current offer. */
async function meetingWithDeliveredOffer(name) {
  const meeting = await newLiveMeeting(name, {
    CONSUMER_MODULE_PLANNER_MODE: 'apply',
    OPENAI_API_KEY: 'synthetic-test-key'
  });
  const rig = await attachLiveSession(meeting);
  const simulator = new LiveProviderSimulator(rig);

  await simulator.turn({
    clientText: POSITION_TURN,
    act: async () => ({ speech: 'Thanks. Roughly how much does your household spend each month?' })
  });
  await settle(rig.durable, rig.session);
  await simulator.turn({
    clientText: SPEND_TURN,
    act: async () => ({ speech: 'Okay. Let me line that up.' })
  });
  await settle(rig.durable, rig.session);

  let token = null;
  await simulator.turn({
    clientText: SNAPSHOT_TURN,
    act: async ({ callTool }) => {
      const state = await callTool('get_state', {});
      token = state.result?.confirmationToken || null;
      return { speech: state.result.confirmationPrompt };
    }
  });
  await settle(rig.durable, rig.session);

  ok(token, `${name}: a ready plan must mint a confirmation token`);
  equal(rig.session.directConfirmationOffer?.readbackFullyDelivered, true,
    `${name}: the certified plan must be delivered before anything can approve it`);
  return { meeting, simulator, token, ...rig };
}

const runCount = async (meeting) => Number((await meeting.env.CONSUMER_DB.prepare(
  'SELECT COUNT(*) AS n FROM consumer_module_runs WHERE session_id = ?'
).bind(meeting.sessionId).first()).n);

/** The certified offer's own plan row, in the state it ended in. */
const planStatuses = async (meeting) => ((await meeting.env.CONSUMER_DB.prepare(
  'SELECT status FROM consumer_realtime_analysis_plans WHERE session_id = ?'
).bind(meeting.sessionId).all()).results || []).map((row) => String(row.status));

/** Every analysis run this session started, in the state it ended in. */
const analysisRunStatuses = async (meeting) => ((await meeting.env.CONSUMER_DB.prepare(
  'SELECT status FROM consumer_analysis_runs WHERE session_id = ?'
).bind(meeting.sessionId).all()).results || []).map((row) => String(row.status));

/* ------------------------------------------------ P1-1: wrong proposition */

/**
 * The client asks one question about the plan, the assistant answers it and
 * asks something else, and the client says yes to THAT.
 *
 * The clarification is not a defect and is not being removed: a delivered offer
 * MUST survive a client asking what it covers, or no one who asks a question
 * can ever approve anything. What was missing is that the approval barrier had
 * no idea which of the two propositions on the table the "yes" was about.
 */
{
  const ANOTHER_QUESTION = 'It covers everything you own and owe in one picture. '
    + 'Separately -- would you like me to add a retirement projection for your wife as well?';
  const { meeting, simulator, token, session, durable } = await meetingWithDeliveredOffer('approval-wrong-proposition');
  const deliveredOffer = structuredClone(session.directConfirmationOffer);

  await simulator.turn({
    clientText: 'What does that actually cover?',
    act: async () => ({ speech: ANOTHER_QUESTION })
  });
  await settle(durable, session);

  equal(session.directConfirmationOffer?.token, deliveredOffer.token,
    'a clarification must not retire the offer the client is still looking at');
  ok((session.directConfirmationOffer.confirmationTurnIds || []).length > 0,
    'and the assistant turn that answered it inherits the offer binding, which is how this got through');

  // The deterministic grammar this replaced could not have stopped it. "Yes"
  // is a clean whole-clause approval by every rule it had.
  equal(classifyExecutionApproval('Yes'), 'affirmed',
    'the grammar this replaced reads a bare "Yes" as agreement, whatever it is agreeing to');

  approvalScript = {
    Yes: {
      decision: 'pure_approval',
      proposition: 'other_assistant_question',
      reason: 'agrees to adding the retirement projection, not to running the delivered plan'
    }
  };
  let result = null;
  await simulator.turn({
    clientText: 'Yes',
    act: async ({ callTool, speak }) => {
      result = (await callTool('confirm_and_run', { confirmationToken: token })).result;
      await speak('Let me set that up.');
      return { alreadySpoken: true };
    }
  });
  await settle(durable, session);

  const envelope = approvalEnvelopes.at(-1);
  equal(envelope.answeredUtterance.isTheCertifiedOffer, false,
    'the reader must be told this reply answered something other than the read-back');
  equal(envelope.answeredUtterance.text, ANOTHER_QUESTION,
    'and must be shown the question it actually answered, in full');
  equal(envelope.offer.deliveredConfirmationPrompt, CONFIRMATION_PROMPT,
    'alongside the exact certified offer, so the two propositions can be told apart');

  equal(result?.ok, false, 'agreement to a different question must not execute the delivered plan');
  equal(result?.code, 'confirmation_answers_other_question',
    'and must say so, so the meeting answers what they actually agreed to');
  equal(await runCount(meeting), 0, 'zero engine executions against the stale offer');
  pass('P1-1: "yes" to a later assistant question cannot execute the delivered plan');
}

/* ------------------------------------------- P1-2: a discarded correction */

/**
 * The client agrees and corrects the ownership of a pension in the same breath,
 * in a language whose characters the old normaliser deleted.
 *
 * No figure moves. The equal-value owner swap is precisely the case the
 * handoff already identified as undetectable by input equality, and it is the
 * case a character class silently erased.
 */
{
  // "Yes, but only my pension" -- Cyrillic, which the old normaliser replaced
  // with spaces before deciding anything.
  const MIXED_REPLY = 'Yes, но только моя '
    + 'пенсия';
  const { meeting, simulator, token, session, durable } = await meetingWithDeliveredOffer('approval-discarded-correction');

  // THE BYPASS, DEMONSTRATED BEFORE IT IS FIXED. This is what the deterministic
  // gate concluded about a reply that carries an exclusion.
  equal(classifyExecutionApproval(MIXED_REPLY), 'affirmed',
    'the grammar this replaced normalised the correction away and called the remainder approval');

  approvalScript = {
    [MIXED_REPLY]: {
      decision: 'semantic_change',
      reason: 'agrees, then narrows the plan to one pension'
    }
  };
  let result = null;
  await simulator.turn({
    clientText: MIXED_REPLY,
    act: async ({ callTool, speak }) => {
      result = (await callTool('confirm_and_run', { confirmationToken: token })).result;
      await speak('Let me take that in.');
      return { alreadySpoken: true };
    }
  });
  await settle(durable, session);

  equal(approvalEnvelopes.at(-1).clientReply, MIXED_REPLY,
    'the reader must receive the complete reply, unnormalised, with the correction still in it');
  equal(result?.ok, false, 'a reply carrying a change must not execute the plan it changed');
  equal(result?.code, 'confirmation_carries_change',
    'and must be refused as a change, not as an unclear answer');
  equal(await runCount(meeting), 0, 'zero engine executions against the stale offer');

  // ROUTED, NOT JUST REFUSED. The change has to reach the interpretation loop,
  // or the client has corrected something into a void.
  ok(extractionCalls > 0 && verificationCalls > 0,
    'the changed turn goes back through the ordinary review, which must re-certify before anyone approves again');

  // AND THE PLAN THEY WERE READ STOPS BEING APPROVABLE. The read-back they
  // heard is no longer a true statement of what they want, so a later bare
  // "yes" must not be able to reach it: it has to be certified, read back and
  // approved again on its own.
  equal(session.directConfirmationOffer, null,
    'a change retires the delivered offer rather than leaving it quietly approvable');
  let afterChange = null;
  await simulator.turn({
    clientText: 'Yes, go ahead.',
    act: async ({ callTool, speak }) => {
      afterChange = (await callTool('confirm_and_run', { confirmationToken: token })).result;
      await speak('Let me read the updated plan back to you.');
      return { alreadySpoken: true };
    }
  });
  await settle(durable, session);
  equal(afterChange?.ok, false, 'and a later approval cannot reach the retired plan');
  equal(afterChange?.code, 'confirmation_context_invalid',
    'it is told there is no current plan to run, so it reads the new one back instead');
  equal(await runCount(meeting), 0, 'still zero engine executions');
  pass('P1-2: an agreement carrying a correction the old normaliser deleted cannot execute');
}

/* ------------------------------------------------ P1-3: the newer-turn fence */

/**
 * The approval is parked waiting for delivery evidence, the client starts
 * speaking again, and only then does the evidence land.
 *
 * The park itself is correct and is kept: an approval that arrives while the
 * read-back's playback acknowledgement is still in flight should wait for it
 * rather than be refused. What was missing is that resuming asked only whether
 * the SPEECH had been delivered, never whether the client had moved on.
 *
 * Both halves are asserted, because a fence that blocks everything proves
 * nothing: the same parked approval, drained with no newer turn, must run.
 */
for (const clientSpeaksAgain of [false, true]) {
  const label = clientSpeaksAgain ? 'a newer turn has begun' : 'nothing has happened since';
  const { meeting, simulator, token, session, durable } = await meetingWithDeliveredOffer(
    `approval-late-${clientSpeaksAgain ? 'fenced' : 'clear'}`
  );

  // Hold the read-back's playback acknowledgement, exactly as a slow browser
  // ACK does, so the approval below parks instead of executing.
  const deliveredAck = session.directPlaybackEvidence.get(
    session.directConfirmationOffer.deliveryAttempt.responseId
  );
  session.directConfirmationOffer.readbackFullyDelivered = false;
  session.directConfirmationOffer.deliveryAttempt.playbackCompleted = false;

  approvalScript = { 'Yes, go ahead.': { decision: 'pure_approval' } };
  const itemId = 'item_late_approval';
  await simulator.send({ type: 'input_audio_buffer.speech_stopped', item_id: itemId });
  await simulator.send({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript: 'Yes, go ahead.'
  });
  const approvalResponse = await simulator.startResponse();
  await simulator.send({
    type: 'response.function_call_arguments.done',
    response_id: approvalResponse.responseId,
    call_id: 'call_late_approval',
    name: 'confirm_and_run',
    arguments: JSON.stringify({ confirmationToken: token })
  });
  equal(session.pendingDirectApprovals.size, 1,
    `${label}: an approval waiting on delivery evidence parks rather than executing`);

  if (clientSpeaksAgain) {
    // THE CLIENT'S NEXT UTTERANCE ENDS. Nothing has been transcribed yet --
    // that is the point: by the time their words land, the parked approval
    // would already have run.
    //
    // `speech_stopped` and not `speech_started` HERE, deliberately. This offer
    // is parked precisely because its playback acknowledgement has not arrived,
    // and a `speech_started` in that state is a barge-in: it would invalidate
    // the read-back and refuse the approval for a reason that has nothing to do
    // with the clock, leaving this test passing whatever happened to the fence.
    // Schedule A below is where `speech_started` is tested, on a read-back that
    // HAS finished playing, so nothing but the clock can refuse it.
    await simulator.send({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_after_approval' });
  }

  // The acknowledgement finally arrives and the parked approval resumes.
  await session.acknowledgeReadbackPlayback({
    responseId: session.directConfirmationOffer.deliveryAttempt.responseId,
    eventId: deliveredAck?.eventId || 'evt_late_playback',
    playback: 'completed'
  });
  await Promise.all(durable.waitUntilPromises);
  await settle(durable, session);

  equal(await runCount(meeting), clientSpeaksAgain ? 0 : 1,
    clientSpeaksAgain
      ? 'zero engine executions once the client has begun a newer turn'
      : 'the same parked approval still executes when nothing has superseded it');
  pass(`P1-3: a late approval resumed after ${label} ${clientSpeaksAgain ? 'cannot execute' : 'executes'}`);
}

/* ============================ Astra's second review: three stale schedules ==
 *
 * The three above are answers about MEANING. These three are answers about
 * TIME: in each one the reading was right and the barriers were right, and a
 * plan still ran because the server learned that the client had spoken again
 * later than the client actually spoke.
 *
 * The invariant they all assert is one sentence. Once newer client input has
 * begun or arrived, an approval belonging to an older client turn must never
 * cause financial execution. Not "usually". Not "unless it was already past the
 * last check".
 */

/* ------------------- A: speech_started reaches the handler mid-approval --- */

/**
 * The read-back has played in full, the client has agreed, the approval is
 * somewhere in its execution path -- and the client starts speaking again.
 *
 * `speech_started` is the moment that matters and the moment the server used to
 * ignore: it registered a newer turn only at `speech_stopped`, so for the whole
 * length of the client's next sentence an older approval was still admissible.
 * Nothing else stops it here. The read-back's playback has completed, so the
 * barge-in path that invalidates an undelivered read-back does not fire, and
 * the offer is delivered, settled and unsuperseded. Only the clock can refuse.
 *
 * Both halves again: with no newer speech the identical schedule executes.
 */
for (const clientSpeaksAgain of [true, false]) {
  const label = clientSpeaksAgain ? 'speech_started arrives' : 'nothing arrives';
  const { meeting, simulator, token, session, durable } = await meetingWithDeliveredOffer(
    `approval-speech-started-${clientSpeaksAgain ? 'fenced' : 'clear'}`
  );
  equal(session.directConfirmationOffer.deliveryAttempt.playbackCompleted, true,
    `${label}: the read-back finished playing, so no barge-in rule can do this test's work for it`);

  approvalScript = { 'Yes, go ahead.': { decision: 'pure_approval' } };
  const release = holdApprovalReader();
  const entered = watchForApprovalReader();

  const itemId = 'item_speech_started_approval';
  await simulator.send({ type: 'input_audio_buffer.speech_stopped', item_id: itemId });
  await simulator.send({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript: 'Yes, go ahead.'
  });
  const approvalResponse = await simulator.startResponse();
  const approvalInFlight = simulator.send({
    type: 'response.function_call_arguments.done',
    response_id: approvalResponse.responseId,
    call_id: 'call_speech_started_approval',
    name: 'confirm_and_run',
    arguments: JSON.stringify({ confirmationToken: token })
  });
  await entered;

  if (clientSpeaksAgain) {
    await simulator.send({
      type: 'input_audio_buffer.speech_started',
      item_id: 'item_client_speaks_again'
    });
    equal(session.clientInputGeneration > session.clientTurnsByItemId.get(itemId).ordinal, true,
      'speech starting is itself newer input: the clock moves before a word is transcribed');
  }

  release();
  await approvalInFlight;
  await settle(durable, session);

  equal(await runCount(meeting), clientSpeaksAgain ? 0 : 1,
    clientSpeaksAgain
      ? 'zero engine executions once the client has started speaking again'
      : 'the identical schedule executes when the client has not');
  pass(`A: an approval in flight when ${label} ${clientSpeaksAgain ? 'cannot execute' : 'executes'}`);
}

/* ------------- B: newer input already on the socket, stuck behind the read - */

/**
 * THE ONE THAT ORDERING ALONE CANNOT FIX.
 *
 * Provider events are processed strictly in order on one chain, and the
 * approval turn's own handler awaits a model call. So newer speech that has
 * ALREADY ARRIVED at the socket sits in that queue -- behind the very approval
 * it should invalidate -- and by the time anything looks at it the plan has
 * run. Every barrier was correct; each of them simply asked a question whose
 * answer had arrived and not yet been read.
 *
 * This drives both the approval and the newer speech through the real socket
 * ingress, so the queue is the production queue. The fix is not to reorder it:
 * it is that arrival is registered by the listener, before anything is queued.
 */
{
  const { meeting, simulator, token, session, durable } = await meetingWithDeliveredOffer('approval-queued-behind-reader');
  approvalScript = { 'Yes, go ahead.': { decision: 'pure_approval' } };
  const release = holdApprovalReader();
  const entered = watchForApprovalReader();

  const itemId = 'item_queued_approval';
  simulator.deliverToSocket({ type: 'input_audio_buffer.speech_stopped', item_id: itemId });
  simulator.deliverToSocket({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript: 'Yes, go ahead.'
  });
  const approvalResponseId = 'resp_queued_approval';
  simulator.deliverToSocket({ type: 'response.created', response: { id: approvalResponseId } });
  const queued = simulator.deliverToSocket({
    type: 'response.function_call_arguments.done',
    response_id: approvalResponseId,
    call_id: 'call_queued_approval',
    name: 'confirm_and_run',
    arguments: JSON.stringify({ confirmationToken: token })
  });
  await entered;

  const approvalGeneration = session.clientTurnsByItemId.get(itemId).ordinal;
  // THE FRAME ARRIVES WHILE THE CHAIN IS BLOCKED. Its handler cannot run --
  // that is the point -- so if arrival were registered by the handler, this
  // would change nothing until after the plan had already run.
  simulator.deliverToSocket({
    type: 'input_audio_buffer.speech_started',
    item_id: 'item_arrived_while_blocked'
  });
  equal(session.clientInputGeneration > approvalGeneration, true,
    'arrival is registered by the listener, ahead of a queue it is not allowed to wait in');

  release();
  await queued;
  await settle(durable, session);

  equal(await runCount(meeting), 0,
    'zero engine executions from input that had arrived but had not been processed');
  pass('B: speech already on the socket, queued behind the approval reader, still stops the plan');
}

/* ------------- C: newer typed input at every await between approval and engine */

/**
 * THE TYPED RACE, TESTED EVERYWHERE IT CAN HAPPEN.
 *
 * A Durable Object serves typed requests concurrently, so a second message can
 * land at any await between the client approving and the engine starting: the
 * context load, the frozen plan load, the plan confirmation, the run record.
 * Astra reproduced one of those. Asserting only that one would leave the test
 * passing the moment the gap moved somewhere else, so this fires at EVERY
 * await, found by counting the database traffic rather than by naming the
 * functions -- the set calibrates itself against whatever the path does today.
 *
 * The last of those points is inside the engine's own caller, after the run
 * record exists, which is why the admission test is asked there too and not
 * only at the tool boundary.
 */
{
  const CLARIFYING_LATER_MESSAGE = 'Actually, hold on -- is the mortgage in that?';

  /** One typed meeting, driven to a delivered certified offer. */
  async function typedMeetingWithDeliveredOffer(name) {
    const meeting = await newLiveMeeting(name, {
      CONSUMER_MODULE_PLANNER_MODE: 'apply',
      CONSUMER_TYPED_LANE_ENABLED: 'true',
      OPENAI_API_KEY: 'synthetic-test-key'
    });
    const interleave = interleavingDatabase(meeting.env.CONSUMER_DB);
    meeting.env.CONSUMER_DB = interleave.database;
    const rig = await attachTypedSession(meeting);

    typedRendererSteps = [{ speech: 'Thanks. Roughly how much do you spend each month?' }];
    await rig.session.handleTextMessage({ text: POSITION_TURN });
    await settle(rig.durable, rig.session);

    typedRendererSteps = [{ speech: 'Okay. Let me line that up.' }];
    await rig.session.handleTextMessage({ text: SPEND_TURN });
    await settle(rig.durable, rig.session);

    typedRendererSteps = [{ tool: 'get_state', args: {} }, { speech: 'Here is the plan.' }];
    const presented = await rig.session.handleTextMessage({ text: SNAPSHOT_TURN });
    await settle(rig.durable, rig.session);
    equal(presented.readback, true, `${name}: the certified plan is put in front of the client`);
    equal(rig.session.directConfirmationOffer?.readbackFullyDelivered, true,
      `${name}: a typed read-back is delivered the moment it is written`);
    return { meeting, interleave, ...rig };
  }

  /** Approve, optionally letting a newer typed message land at statement `at`. */
  async function approveTyped(rig, { at = 0 } = {}) {
    approvalScript = { 'Yes, go ahead.': { decision: 'pure_approval' } };
    typedRendererSteps = [
      { tool: 'confirm_and_run', args: { confirmationToken: rig.session.directConfirmationOffer.token } },
      { speech: 'Running that now.' }
    ];
    let landed = false;
    rig.interleave.arm(at, () => {
      landed = true;
      // THE REAL INGRESS, not a poke at the counter. A second typed request is
      // exactly what production would deliver here, and registering its arrival
      // is the first thing that request does.
      typedRendererSteps.push({ speech: 'Let me check that for you.' });
      rig.session.handleTextMessage({ text: CLARIFYING_LATER_MESSAGE }).catch(() => {});
    });
    await rig.session.handleTextMessage({ text: 'Yes, go ahead.' });
    const statements = rig.interleave.statements();
    rig.interleave.disarm();
    await settle(rig.durable, rig.session);
    return { landed, statements };
  }

  // A TYPED REQUEST IS NEWER INPUT FROM ITS FIRST INSTRUCTION.
  //
  // Registration happens before the request awaits anything at all, so there is
  // no arrangement of awaits inside the typed path -- present or future -- that
  // can leave a message arrived-but-unregistered while an older approval runs.
  // Today the statements between the door and the turn record happen to be
  // synchronous anyway; this pins the property rather than that coincidence.
  {
    const rig = await typedMeetingWithDeliveredOffer('approval-typed-ingress-clock');
    const before = rig.session.clientInputGeneration;
    typedRendererSteps = [{ speech: 'Let me check.' }];
    const pending = rig.session.handleTextMessage({ text: CLARIFYING_LATER_MESSAGE });
    equal(rig.session.clientInputGeneration, before + 1,
      'the clock moves at the door, before the request awaits anything');
    await pending;
    await settle(rig.durable, rig.session);
    // And an empty request is not something the client said.
    const afterMessage = rig.session.clientInputGeneration;
    await rig.session.handleTextMessage({ text: '   ' }).catch(() => {});
    equal(rig.session.clientInputGeneration, afterMessage,
      'an empty message is refused, not treated as the client speaking again');
    pass('C: a typed message registers as newer input before the request awaits anything');
  }

  // CALIBRATE. One clean approval, counting the database traffic, so the
  // interleaving points below are derived from what the path actually does
  // rather than from what it did when this test was written.
  const calibration = await typedMeetingWithDeliveredOffer('approval-typed-calibration');
  const { statements } = await approveTyped(calibration);
  equal(await runCount(calibration.meeting), 1, 'the calibration approval executes exactly once');
  const engineEntry = statements.findIndex((sql) => /INSERT INTO consumer_analysis_runs/i.test(sql)) + 1;
  ok(engineEntry > 0, 'the approval path reaches the analysis run record');
  // The last read before the tool hands the approval to the execution layer.
  // Everything at or before it is still a read: a withdrawn approval that far
  // out must leave the certified plan exactly as it found it, rather than
  // confirming it and then failing it.
  const lastReadOnlyStep = statements
    .map((sql) => sql.replace(/\s+/g, ' ').trim())
    .findIndex((sql) => /^SELECT \* FROM consumer_realtime_analysis_plans WHERE id = \?/i.test(sql)) + 1;
  ok(lastReadOnlyStep > 0 && lastReadOnlyStep < engineEntry,
    'the frozen plan is read before anything is written');
  // The interleaving points are derived, not written down, so when one of them
  // fails there is otherwise nothing to look at. APPROVAL_INTERLEAVE_TRACE=1
  // prints the path this run actually measured.
  if (process.env.APPROVAL_INTERLEAVE_TRACE === '1') {
    statements.forEach((sql, index) => console.info(
      `  ${index + 1}. ${sql.replace(/\s+/g, ' ').trim().slice(0, 110)}`
    ));
  }
  pass(`C: calibrated ${engineEntry} awaits between a typed approval and the engine`);

  for (let at = 1; at <= engineEntry; at += 1) {
    const rig = await typedMeetingWithDeliveredOffer(`approval-typed-interleave-${at}`);
    const { landed } = await approveTyped(rig, { at });
    equal(landed, true, `C@${at}: the newer typed message actually landed at this await`);
    equal(await runCount(rig.meeting), 0,
      `C@${at}: zero engine executions when a newer typed message arrives at await ${at}`);
    const runs = await analysisRunStatuses(rig.meeting);
    equal(runs.filter((status) => status === 'complete').length, 0,
      `C@${at}: and nothing completes`);
    // AND NOTHING IS STARTED THAT SHOULD NOT HAVE BEEN. Only the last await is
    // inside the engine's own caller, past the point where a run record has to
    // exist; everywhere earlier, a withdrawn approval must leave no trace of an
    // analysis it never began. That is what the admission test asked before
    // `createAnalysisRun` is for, and it is why one check is not enough.
    if (at < engineEntry) {
      equal(runs.length, 0, `C@${at}: a withdrawn approval starts no analysis run at all`);
    }
    if (at <= lastReadOnlyStep) {
      // NOTHING WRITTEN, NOT EVEN THE CONFIRMATION. Refusing this early is what
      // the admission test asked at the tool boundary is for: a plan that is
      // confirmed and then failed has consumed its nonce, and the client's
      // offer is spent on an approval that never should have got that far.
      equal(await planStatuses(rig.meeting), ['prepared'],
        `C@${at}: the certified plan is left untouched, not confirmed and then failed`);
    }
  }
  pass(`C: a newer typed message arriving at any of the ${engineEntry} awaits before the engine stops the plan`);
}

/* --------------------------------------------- one utterance is one turn --- */

/**
 * A CONTROL, AND A NECESSARY ONE.
 *
 * The clock now moves on `speech_started`, and a single utterance produces
 * `speech_started`, then `speech_stopped`, then a transcription -- three events
 * naming one thing the client did. If each moved the clock, every approval
 * would be superseded by its own utterance and nothing could ever run. The
 * dedup is what makes the fence usable rather than merely safe.
 */
{
  const { meeting, simulator, token, session, durable } = await meetingWithDeliveredOffer('approval-one-utterance');
  const before = session.clientInputGeneration;
  const itemId = 'item_single_utterance';
  await simulator.send({ type: 'input_audio_buffer.speech_started', item_id: itemId });
  await simulator.send({ type: 'input_audio_buffer.speech_stopped', item_id: itemId });
  await simulator.send({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript: 'Yes, go ahead.'
  });
  equal(session.clientInputGeneration - before, 1,
    'three provider events for one utterance are one arrival, not three');
  equal([...session.clientTurnsByItemId.values()].filter((turn) => turn.itemId === itemId).length, 1,
    'and one client turn, not three');

  approvalScript = { 'Yes, go ahead.': { decision: 'pure_approval' } };
  const approvalResponse = await simulator.startResponse();
  await simulator.send({
    type: 'response.function_call_arguments.done',
    response_id: approvalResponse.responseId,
    call_id: 'call_single_utterance',
    name: 'confirm_and_run',
    arguments: JSON.stringify({ confirmationToken: token })
  });
  await settle(durable, session);
  equal(await runCount(meeting), 1,
    'so the approval that utterance carried is still the client\'s latest word, and runs');
  pass('one utterance is one arrival: start, stop and transcription do not supersede each other');
}

/* ------------------- approval after a clarification about the same plan --- */

/**
 * THE CASE THE PROPOSITION RULE MUST NOT BREAK.
 *
 * P1-1 refuses a "yes" that answered a DIFFERENT question. The thing that must
 * survive that is the ordinary one: the client asks what the plan covers, the
 * assistant answers and asks again whether to run it -- the same certified
 * plan, re-put in shorter words -- and they say yes. The reply is bound to a
 * later assistant turn, `isTheCertifiedOffer` is false, and it is still an
 * approval of the offer.
 *
 * It must also still take the fast path: no planner, no verifier, no second
 * opinion on financial content nobody changed.
 */
{
  const RE_ASKED = 'It covers everything you own and owe in one picture -- '
    + 'the savings, the house and its mortgage, both pensions and your monthly spending. '
    + 'Shall I run exactly that now?';
  const { meeting, simulator, token, session, durable } = await meetingWithDeliveredOffer('approval-after-clarification');
  const deliveredOffer = structuredClone(session.directConfirmationOffer);

  approvalScript = {};
  await simulator.turn({
    clientText: 'What does that actually cover?',
    act: async () => ({ speech: RE_ASKED })
  });
  await settle(durable, session);
  equal(session.directConfirmationOffer?.token, deliveredOffer.token,
    'a clarification leaves the certified plan on the table');

  const extractionsBefore = extractionCalls;
  const verificationsBefore = verificationCalls;
  approvalScript = {
    Yes: {
      decision: 'pure_approval',
      proposition: 'offer',
      reason: 'agrees to running the plan that was read back, re-put in the same terms'
    }
  };
  let result = null;
  await simulator.turn({
    clientText: 'Yes',
    act: async ({ callTool, speak }) => {
      result = (await callTool('confirm_and_run', { confirmationToken: token })).result;
      await speak(result?.speakableText || 'Running that now.');
      return { alreadySpoken: true };
    }
  });
  await settle(durable, session);

  equal(approvalEnvelopes.at(-1).answeredUtterance.isTheCertifiedOffer, false,
    'the reply is bound to a later assistant turn, exactly as in P1-1');
  equal(approvalEnvelopes.at(-1).answeredUtterance.text, RE_ASKED,
    'and the reader is shown that the later turn re-asked the same plan');
  equal(approvalEnvelopes.at(-1).interveningContext.complete, true,
    'with the whole exchange since the read-back available to read it against');
  ok(approvalEnvelopes.at(-1).interveningContext.turns.length >= 2,
    'and the clarification exchange itself is in it, not summarised away');

  // AND WHEN IT IS NOT ALL THERE, THE READER IS TOLD SO. A read-back older than
  // the window this reader is given must not reach it as an empty array, which
  // would be a confident statement that nothing was said in between.
  {
    const approvingTurn = [...session.clientTurnsByItemId.values()].at(-1);
    const realReadbackTurnId = session.directConfirmationOffer?.assistantTurnId;
    session.directConfirmationOffer.assistantTurnId = 'turn_older_than_the_window';
    const truncated = await session.buildExecutionApprovalEnvelope(approvingTurn);
    session.directConfirmationOffer.assistantTurnId = realReadbackTurnId;
    equal(truncated.interveningContext.complete, false,
      'a read-back outside the window is reported as incomplete context, never as no context');
    ok(truncated.interveningContext.turns.length > 0,
      'and everything that IS still available is preserved and sent');
  }
  equal(result?.ok, true, `approval of the same plan, re-put, must execute (${JSON.stringify(result?.code)})`);
  equal(await runCount(meeting), 1, 'exactly once');
  equal(extractionCalls - extractionsBefore, 0, 'and on the fast path: no planner pass');
  equal(verificationCalls - verificationsBefore, 0, 'and no verifier pass');
  pass('an approval after a clarification about the same certified plan still takes the fast path');
}

/* ------------------------------------------------------- the positive path */

/**
 * The whole point of the change. A person hears their plan, says yes in
 * ordinary words, and it runs -- once, immediately, without a second stochastic
 * opinion being invited to disagree with the first.
 */
{
  approvalScript = {};
  const { meeting, simulator, token, session, durable } = await meetingWithDeliveredOffer('approval-positive-path');
  const deliveredOffer = structuredClone(session.directConfirmationOffer);
  const extractionsBefore = extractionCalls;
  const verificationsBefore = verificationCalls;
  const envelopesBefore = approvalEnvelopes.length;

  let result = null;
  await simulator.turn({
    clientText: 'Grand, go ahead',
    act: async ({ callTool, speak }) => {
      result = (await callTool('confirm_and_run', { confirmationToken: token })).result;
      await speak(result?.speakableText || 'That is running now.');
      return { alreadySpoken: true };
    }
  });
  await settle(durable, session);

  equal(result?.ok, true, `a natural approval of the delivered plan must execute (${JSON.stringify(result?.code)})`);
  equal(result?.status, 'complete', 'and must complete rather than stall');
  equal(await runCount(meeting), 1, 'exactly one engine execution');
  equal(session.directConfirmationOffer?.planId, deliveredOffer.planId,
    'and it is the plan the client was read, not a replacement for it');

  // NO SECOND OPINION ON UNCHANGED SEMANTICS. This is the barrier the whole
  // design turns on: a pure approval adds no financial meaning, so nothing
  // re-authors or re-audits the plan the client has already accepted.
  equal(extractionCalls - extractionsBefore, 0,
    'a pure approval must not rerun the planner over semantics nobody changed');
  equal(verificationCalls - verificationsBefore, 0,
    'nor the verifier, which is what withdrew a plan a client had already approved on 2026-09-05');
  equal(approvalEnvelopes.length - envelopesBefore, 1,
    'the approval turn costs exactly one bounded reading and nothing else');
  pass('an ordinary approval runs the delivered plan exactly once, without reopening it');

  // DUPLICATE APPROVAL. A second tool call against the same offer joins the
  // receipt the first one produced; it does not run anything again.
  let duplicate = null;
  await simulator.turn({
    clientText: 'Yes, go ahead.',
    act: async ({ callTool, speak }) => {
      duplicate = (await callTool('confirm_and_run', { confirmationToken: token })).result;
      await speak('It is already running.');
      return { alreadySpoken: true };
    }
  });
  await settle(durable, session);
  equal(await runCount(meeting), 1, 'a duplicate approval cannot execute a second time');
  ok(duplicate?.status === 'complete' || duplicate?.ok === false,
    'and either joins the existing receipt or is refused, never starts a second run');

  const stage = (await meeting.env.CONSUMER_DB.prepare(
    'SELECT stage FROM consumer_sessions WHERE id = ?'
  ).bind(meeting.sessionId).first()).stage;
  equal(stage, 'results', 'the client reaches their results');
  pass('a duplicate approval cannot execute twice, and the client reaches results');
}

console.info(`[ApprovalMeaning] ${checks} checks passed.`);
