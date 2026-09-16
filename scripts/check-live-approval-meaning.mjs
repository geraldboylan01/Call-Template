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
/**
 * Hold the reading of ONE reply while the rest of the meeting carries on.
 *
 * The whole-gate version above cannot express the ordering that matters here:
 * a correction whose meaning is still being decided, and an approval arriving
 * behind it whose own meaning is decided immediately.
 */
let heldApprovalReplies = new Map();
function holdApprovalReaderFor(clientReply) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let reached;
  const entered = new Promise((resolve) => { reached = resolve; });
  heldApprovalReplies.set(clientReply, { gate, reached });
  return { entered, release: () => { heldApprovalReplies.delete(clientReply); release(); } };
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
    const held = heldApprovalReplies.get(String(requestBody?.clientReply || ''));
    if (held) {
      held.reached();
      await held.gate;
    }
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

/** How many assistant turns this meeting has committed so far. */
const assistantTurnCount = async (meeting) => Number((await meeting.env.CONSUMER_DB.prepare(
  "SELECT COUNT(*) AS n FROM consumer_realtime_final_turns WHERE realtime_session_id = ? AND role = 'assistant'"
).bind(meeting.meetingId).first()).n);

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
    equal(session.clientInputSequence > session.clientTurnsByItemId.get(itemId).ordinal, true,
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
  equal(session.clientInputSequence > approvalGeneration, true,
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
  const CORRECTION_MESSAGE = 'Actually, leave my wife\'s pension out of it.';

  /** One typed message as the route really receives it: a POST to /message. */
  const typedRequest = (body) => new Request('http://live-session/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

  /**
   * A typed message whose BYTES HAVE ARRIVED AND WHICH NOBODY HAS READ.
   *
   * This is the shape of Astra's schedule, and it cannot be faked by calling
   * the handler later: the request must be at the door, with its body pending,
   * while an older approval is still walking towards the engine. A real Request
   * over a stream the test controls is exactly that -- `request.text()` inside
   * the route suspends until `deliver()` is called.
   */
  function suspendedTypedRequest(body) {
    let controller = null;
    const stream = new ReadableStream({ start(source) { controller = source; } });
    return {
      request: new Request('http://live-session/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: stream,
        duplex: 'half'
      }),
      deliver() {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
        controller.close();
      },
      /** The body never arrives: a dropped connection, mid-request. */
      fail() { controller.error(new Error('the client connection dropped mid-body')); }
    };
  }

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
  async function approveTyped(rig, { at = 0, onFire = null, overHttp = false } = {}) {
    approvalScript = { 'Yes, go ahead.': { decision: 'pure_approval' } };
    typedRendererSteps = [
      { tool: 'confirm_and_run', args: { confirmationToken: rig.session.directConfirmationOffer.token } },
      { speech: 'Running that now.' }
    ];
    let landed = false;
    rig.interleave.arm(at, () => {
      landed = true;
      if (onFire) return onFire();
      // THE REAL INGRESS, not a poke at the counter. A second typed request is
      // exactly what production would deliver here, and registering its arrival
      // is the first thing that request does.
      typedRendererSteps.push({ speech: 'Let me check that for you.' });
      rig.session.handleTextMessage({ text: CLARIFYING_LATER_MESSAGE }).catch(() => {});
      return undefined;
    });
    // The tool result the model is actually handed back, observed after the
    // real barrier has run. The HTTP reply carries the assistant's next line,
    // not the reason a plan did or did not run.
    let toolResult = null;
    const dispatch = rig.session.dispatchTextToolCall.bind(rig.session);
    rig.session.dispatchTextToolCall = async (...args) => {
      toolResult = await dispatch(...args);
      return toolResult;
    };
    const approval = overHttp
      ? rig.session.fetch(typedRequest({ text: 'Yes, go ahead.' })).then((response) => response.json())
      : rig.session.handleTextMessage({ text: 'Yes, go ahead.' });
    const reply = await approval;
    rig.session.dispatchTextToolCall = dispatch;
    const statements = rig.interleave.statements();
    rig.interleave.disarm();
    await settle(rig.durable, rig.session);
    return { landed, statements, reply, toolResult };
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
    const before = rig.session.clientInputSequence;
    typedRendererSteps = [{ speech: 'Let me check.' }];
    const pending = rig.session.handleTextMessage({ text: CLARIFYING_LATER_MESSAGE });
    equal(rig.session.clientInputSequence, before + 1,
      'the clock moves at the door, before the request awaits anything');
    await pending;
    await settle(rig.durable, rig.session);
    // And an empty request is not something the client said.
    const afterMessage = rig.session.clientInputSequence;
    await rig.session.handleTextMessage({ text: '   ' }).catch(() => {});
    equal(rig.session.clientInputSequence, afterMessage,
      'an empty message is refused, not treated as the client speaking again');
    pass('C: a typed message registers as newer input before the request awaits anything');
  }

  // CALIBRATE. One clean approval, counting the database traffic, so the
  // interleaving points below are derived from what the path actually does
  // rather than from what it did when this test was written.
  const calibration = await typedMeetingWithDeliveredOffer('approval-typed-calibration');
  const extractionsBeforeTyped = extractionCalls;
  const verificationsBeforeTyped = verificationCalls;
  const { statements, toolResult: calibratedResult } = await approveTyped(calibration, { overHttp: true });
  equal(calibratedResult?.ok, true,
    `an ordinary typed approval over /message must execute (${JSON.stringify(calibratedResult?.code)})`);
  equal(await runCount(calibration.meeting), 1, 'the calibration approval executes exactly once');
  // THE FAST PATH IS STILL THE FAST PATH. Registering arrivals at the door
  // must not have turned an ordinary approval into a turn that reopens the plan.
  equal(extractionCalls - extractionsBeforeTyped, 0,
    'a typed pure approval runs no planner pass');
  equal(verificationCalls - verificationsBeforeTyped, 0,
    'and no verifier pass');
  // AND A SECOND APPROVAL OF THE SAME OFFER JOINS THE RECEIPT. The door moves
  // the clock for it, and the approval it carries is still its own latest word.
  typedRendererSteps = [
    { tool: 'confirm_and_run', args: { confirmationToken: calibration.session.directConfirmationOffer.token } },
    { speech: 'It is already running.' }
  ];
  approvalScript = { 'Yes, go ahead.': { decision: 'pure_approval' } };
  await calibration.session.fetch(typedRequest({ text: 'Yes, go ahead.' }));
  await settle(calibration.durable, calibration.session);
  equal(await runCount(calibration.meeting), 1, 'a duplicate typed approval cannot execute a second time');
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

  /* --------- D: a correction that has arrived and has not been read yet --- */

  /**
   * THE LAST GAP, AND THE ONE THAT ONLY THE DOOR CAN CLOSE.
   *
   * `/message` could not register a typed arrival until it had read the body,
   * because the client's own name for the message -- what makes a retry the
   * same utterance -- is inside it. So a correction whose bytes had ALREADY
   * arrived sat in that await while an older approval walked past the execution
   * admission test seeing a clock that had not moved. Nothing was slow and
   * nothing was out of order: the message was simply at the door, unread.
   *
   * This drives the real route with a real Request whose body stream the test
   * holds shut, and fires it at the last await before the engine -- the point
   * where the old plan was closest to running. The approval must be refused,
   * and the refusal must be the clock's, not an accident of some other barrier.
   */
  // Astra's own schedule is the second of these -- the correction reaching the
  // door at the LAST await, where the plan was closest to running. The first is
  // here because the same unread request must also be seen by the first barrier
  // that looks, not only by the last one: if the clock moves at the door, every
  // check downstream of it inherits that, and the two refusals below name two
  // different barriers reaching the same answer.
  for (const { at, where, barrier } of [
    { at: 1, where: 'before the approval has even been read', barrier: 'confirmation_superseded_by_turn' },
    { at: engineEntry, where: 'at the last await before the engine', barrier: 'execution_admission_withdrawn' }
  ]) {
    const rig = await typedMeetingWithDeliveredOffer(`approval-typed-http-arrival-${at}`);
    const approvalGeneration = rig.session.clientInputSequence + 1;
    let correction = null;
    let correctionInFlight = null;
    let clockMovedWhileUnread = false;

    const { landed, toolResult } = await approveTyped(rig, {
      at,
      overHttp: true,
      onFire: () => {
        correction = suspendedTypedRequest({ text: CORRECTION_MESSAGE });
        // Started, not awaited, and its body cannot be delivered yet. The route
        // is now suspended inside `readInternalJson`, exactly where a request
        // whose bytes have arrived but have not been drained would be.
        correctionInFlight = rig.session.fetch(correction.request).then((r) => r.json());
        // SYNCHRONOUSLY, while that body is still unread.
        clockMovedWhileUnread = rig.session.clientInputSequence > approvalGeneration;
      }
    });

    equal(landed, true, `D@${at}: the correction reached the route while the approval was in flight`);
    equal(clockMovedWhileUnread, true,
      `D@${at}: a typed message is newer input from the instant it arrives, not from when its body is read`);
    equal(await runCount(rig.meeting), 0,
      `D@${at}: zero engine executions from a plan a correction had already superseded`);
    equal(toolResult?.ok, false, `D@${at}: the approval is refused`);
    equal(toolResult?.diagnosticCode || toolResult?.code, barrier,
      `D@${at}: refused by the clock ${where}, not by some other barrier that happened to catch it`);
    const runs = await analysisRunStatuses(rig.meeting);
    equal(runs.filter((status) => status === 'complete').length, 0, `D@${at}: nothing completes`);

    // Let the correction finish, so the meeting ends where a real one would.
    typedRendererSteps.push({ speech: 'Understood -- leaving that out.' });
    correction.deliver();
    await correctionInFlight;
    await settle(rig.durable, rig.session);
    equal(await runCount(rig.meeting), 0,
      `D@${at}: and still nothing has run once the correction lands`);
    pass(`D: a correction at the door with its body unread stops the older approval, ${where}`);
  }

  /* ======================= Astra's third review: three reorderings ========= */

  /**
   * THE INVARIANT THESE THREE ARE ABOUT.
   *
   * Once newer genuine client input has ARRIVED, an approval belonging to an
   * earlier client-input generation must never regain authority to execute.
   *
   * The clock alone does not give that. A clock answers "is anything newer than
   * me?", and all three of these slip past that question in different ways: by
   * being newer than the unread thing rather than older than it, by resending
   * until they are newest, and by waiting for the unread thing to be forgotten.
   * What they have in common is that the server let a plan run while it did not
   * yet know everything the client had sent.
   */

  /* -- E1: an unread correction, overtaken by an approval that came after it - */

  /**
   * The correction is at the door with its body unread. The approval arrives
   * AFTER it, so it is the newest thing the client has sent -- and a barrier
   * that only asks "is anything newer than me?" says no, correctly, and lets it
   * run. The correction is older, and was never read.
   */
  {
    const rig = await typedMeetingWithDeliveredOffer('approval-overtakes-unread');
    const correction = suspendedTypedRequest({ text: CORRECTION_MESSAGE });
    const correctionInFlight = rig.session.fetch(correction.request).then((r) => r.json());

    approvalScript = { 'Yes, go ahead.': { decision: 'pure_approval' } };
    typedRendererSteps = [
      { tool: 'confirm_and_run', args: { confirmationToken: rig.session.directConfirmationOffer.token } },
      { speech: 'Running that now.' }
    ];
    let toolResult = null;
    const dispatch = rig.session.dispatchTextToolCall.bind(rig.session);
    rig.session.dispatchTextToolCall = async (...args) => {
      toolResult = await dispatch(...args);
      return toolResult;
    };
    await (await rig.session.fetch(typedRequest({ text: 'Yes, go ahead.' }))).json();
    rig.session.dispatchTextToolCall = dispatch;
    await settle(rig.durable, rig.session);

    equal(await runCount(rig.meeting), 0,
      'E1: zero engine executions while a correction that arrived first is still unread');
    equal(toolResult?.ok, false, 'E1: the approval is refused');
    typedRendererSteps.push({ speech: 'Understood -- leaving that out.' });
    correction.deliver();
    await correctionInFlight;
    await settle(rig.durable, rig.session);
    equal(await runCount(rig.meeting), 0, 'E1: and still nothing once the correction lands');
    pass('E1: an approval cannot overtake an earlier client message the server has not read');
  }

  /* -- E2: an unidentified retry, resent until it is the newest thing said --- */

  /**
   * The approval carries no clientTurnId, so every resend is a NEW utterance
   * with a new id and a newer place in the queue. The first one is correctly
   * refused because the correction arrived after it. The second is newer than
   * the correction -- so on a clock alone it is current, and it runs, past a
   * correction that has still never been read.
   */
  {
    const rig = await typedMeetingWithDeliveredOffer('approval-retry-overtakes');
    approvalScript = { 'Yes, go ahead.': { decision: 'pure_approval' } };

    // The approval is sent, and the correction arrives while it is in flight.
    let correction = null;
    let correctionInFlight = null;
    const firstAttempt = await approveTyped(rig, {
      at: 3,
      overHttp: true,
      onFire: () => {
        correction = suspendedTypedRequest({ text: CORRECTION_MESSAGE });
        correctionInFlight = rig.session.fetch(correction.request).then((r) => r.json());
      }
    });
    equal(firstAttempt.toolResult?.ok, false,
      'E2: the first attempt is refused, because the correction arrived after it');
    equal(await runCount(rig.meeting), 0, 'E2: and nothing has run');

    // The client's browser resends the approval. It carries no clientTurnId, so
    // the server has no way to know it is the same words -- it is simply the
    // newest thing that has arrived.
    typedRendererSteps = [
      { tool: 'confirm_and_run', args: { confirmationToken: rig.session.directConfirmationOffer?.token || 'gone' } },
      { speech: 'Running that now.' }
    ];
    let retryResult = null;
    const dispatch = rig.session.dispatchTextToolCall.bind(rig.session);
    rig.session.dispatchTextToolCall = async (...args) => {
      retryResult = await dispatch(...args);
      return retryResult;
    };
    await (await rig.session.fetch(typedRequest({ text: 'Yes, go ahead.' }))).json();
    rig.session.dispatchTextToolCall = dispatch;
    await settle(rig.durable, rig.session);

    equal(await runCount(rig.meeting), 0,
      'E2: zero engine executions from an approval resent until it was the newest thing said');
    equal(retryResult?.ok, false, 'E2: the resent approval is refused too');
    typedRendererSteps.push({ speech: 'Understood -- leaving that out.' });
    correction.deliver();
    await correctionInFlight;
    await settle(rig.durable, rig.session);
    equal(await runCount(rig.meeting), 0, 'E2: and still nothing once the correction lands');
    pass('E2: resending an approval until it is newest cannot carry it past unread input');
  }

  /* -- E3: a failed body, and the approval it was supposed to have killed ---- */

  /**
   * The correction arrives while the approval is in flight, and its connection
   * then drops before the body is read. If arriving is something the server can
   * take back -- if the clock can be wound down when a request turns out to
   * have carried nothing readable -- then the approval it had invalidated
   * becomes current again, and runs. Arrival has to be irreversible.
   */
  {
    const rig = await typedMeetingWithDeliveredOffer('approval-failed-body-restores');
    let correction = null;
    let correctionInFlight = null;

    const { toolResult } = await approveTyped(rig, {
      at: engineEntry,
      overHttp: true,
      onFire: () => {
        correction = suspendedTypedRequest({ text: CORRECTION_MESSAGE });
        correctionInFlight = rig.session.fetch(correction.request).then((r) => r.json()).catch(() => null);
        // The connection drops. The route will never learn what this said --
        // which is exactly why it must go on counting as something the client
        // sent.
        correction.fail();
      }
    });
    await correctionInFlight;
    await settle(rig.durable, rig.session);

    equal(await runCount(rig.meeting), 0,
      'E3: zero engine executions after a client message arrived and failed unread');
    equal(toolResult?.ok, false, 'E3: the approval is refused');

    // AND IT STAYS REFUSED. A second attempt at the same plan must not find the
    // clock wound back to where it was before the failed request.
    typedRendererSteps = [
      { tool: 'confirm_and_run', args: { confirmationToken: rig.session.directConfirmationOffer?.token || 'gone' } },
      { speech: 'Running that now.' }
    ];
    await rig.session.fetch(typedRequest({ text: 'Yes, go ahead.', clientTurnId: 'e3-approval-0001' }));
    await settle(rig.durable, rig.session);
    equal(await runCount(rig.meeting), 0,
      'E3: and a later attempt cannot inherit authority the failed request removed');
    pass('E3: a client message that arrived and failed unread can never be taken back');
  }

  /* -------------- a retry keeps its identity without reviving authority ---- */

  /**
   * WHAT A RETRY IS AND WHAT IT IS NOT.
   *
   * It is not a second utterance: it names a turn the conversation already has,
   * so it creates no turn, takes no place in the conversation, and moves no
   * ordinal. But it IS an arrival -- the client's browser really did send it --
   * and arrivals are irreversible here, because the only alternative is a clock
   * that can be wound back, which is how an older approval came back to life.
   *
   * So a retry spends a sequence and returns the turn it resends -- and moves
   * nothing. The turn stays where it happened. What the spent sequence costs is
   * any approval that was in flight when the retry landed, which is the right
   * price: a resend proves the client did not get an answer, not that they
   * still want what they wanted.
   */
  {
    const rig = await typedMeetingWithDeliveredOffer('approval-typed-retry');
    const clientTurnId = 'retry-0123456789ab';
    typedRendererSteps = [{ speech: 'Understood.' }];
    const first = await (await rig.session.fetch(
      typedRequest({ text: CORRECTION_MESSAGE, clientTurnId })
    )).json();
    await settle(rig.durable, rig.session);
    equal(first.ok, true, 'the first message is accepted');
    const turnsAfterFirst = rig.session.clientTurnsByItemId.size;
    const sequenceAfterFirst = rig.session.clientInputSequence;
    const sentTurn = [...rig.session.clientTurnsByItemId.values()].at(-1);
    const ordinalAfterFirst = sentTurn.ordinal;

    typedRendererSteps = [{ speech: 'Understood.' }];
    const retry = await (await rig.session.fetch(
      typedRequest({ text: CORRECTION_MESSAGE, clientTurnId })
    )).json();
    await settle(rig.durable, rig.session);

    equal(retry.turnId, first.turnId, 'a retry is the same turn the client already sent');
    equal(rig.session.clientTurnsByItemId.size, turnsAfterFirst,
      'and creates no second turn');
    equal(sentTurn.ordinal, ordinalAfterFirst,
      'its place in the conversation does not move: a resend is not a later thing said');
    ok(rig.session.clientInputSequence > sequenceAfterFirst,
      'but it did arrive, and arriving is never taken back');
    equal(rig.session.pendingClientInput.size, 0,
      'and it leaves nothing outstanding, because its content was already known');

    // A REJECTED REQUEST IS STILL A REQUEST THAT ARRIVED. It cannot be read, so
    // it cannot be proved harmless, and the one thing it must never do is hand
    // authority back to an approval that was current before it.
    const beforeEmpty = rig.session.clientInputSequence;
    const empty = await (await rig.session.fetch(typedRequest({ text: '   ' }))).json();
    equal(empty.ok, false, 'an empty message is refused');
    ok(rig.session.clientInputSequence > beforeEmpty,
      'and still counts as something the client sent, so nothing older regains authority');
    equal(rig.session.pendingClientInput.size, 0,
      'while leaving nothing outstanding for the meeting to wait on');
    pass('a retry keeps its turn and its place, and no arrival is ever taken back');
  }

  /* --------- a retry keeps its identity and reopens no authorization ------- */

  /**
   * WHAT A RETRY IS ALLOWED TO DO, AND WHAT IT IS NOT.
   *
   * It is not a second utterance: it names a turn the conversation already has,
   * so it creates no turn, takes no place in the conversation, moves no
   * ordinal, and buys no second planning pass. That is its causal identity, and
   * it is preserved.
   *
   * It is also not a way back in. It really did arrive, so it spends a
   * sequence, and an approval that was in flight when it landed is refused.
   * That is the fail-closed direction and it is deliberate: a retry carries no
   * evidence that the client still wants what they wanted, only that they did
   * not get an answer. The way back is the client approving again -- which is a
   * turn of its own, read on its own, and executes on its own.
   */
  {
    const rig = await typedMeetingWithDeliveredOffer('approval-retry-of-itself');
    const clientTurnId = 'inflight-00000001';
    approvalScript = { 'Yes, go ahead.': { decision: 'pure_approval' } };
    typedRendererSteps = [
      { tool: 'confirm_and_run', args: { confirmationToken: rig.session.directConfirmationOffer.token } },
      { speech: 'Running that now.' }
    ];
    let toolResult = null;
    let turnsWhenRetried = 0;
    let ordinalWhenRetried = null;
    const dispatch = rig.session.dispatchTextToolCall.bind(rig.session);
    rig.session.dispatchTextToolCall = async (...args) => {
      toolResult = await dispatch(...args);
      return toolResult;
    };
    const turnsBefore = rig.session.clientTurnsByItemId.size;
    // Fired after the original has opened its own reply, so the resend is a
    // second request racing it rather than one that steals its turn binding --
    // the ordering a browser retry actually produces. Started, not awaited:
    // the resend now ADOPTS the original's reply rather than writing a second
    // one, so waiting for it here would be waiting for the request that is
    // waiting for this callback.
    let resendInFlight = null;
    rig.interleave.arm(7, () => {
      resendInFlight = rig.session
        .fetch(typedRequest({ text: 'Yes, go ahead.', clientTurnId }))
        .then((response) => response.json());
    });
    const originalReply = await (await rig.session
      .fetch(typedRequest({ text: 'Yes, go ahead.', clientTurnId }))).json();
    const resentReply = await resendInFlight;
    rig.session.dispatchTextToolCall = dispatch;
    rig.interleave.disarm();
    await settle(rig.durable, rig.session);
    turnsWhenRetried = rig.session.clientTurnsByItemId.size;
    ordinalWhenRetried = [...rig.session.clientTurnsByItemId.values()].at(-1).ordinal;
    equal(resentReply.assistantText, originalReply.assistantText,
      'the resend adopts the reply its original committed, rather than writing a second one');

    // IDENTITY RETAINED.
    equal(turnsWhenRetried, turnsBefore + 1, 'the resend adds no turn of its own');
    equal(ordinalWhenRetried, rig.session.clientInputSequence - 1,
      'the turn keeps the place it was born with while the sequence moves past it');

    // AUTHORIZATION NOT REOPENED.
    equal(toolResult?.ok, false, 'the in-flight approval is refused, not resurrected');
    equal(await runCount(rig.meeting), 0, 'and nothing runs');

    // AND THE WAY BACK IS A TURN, NOT A RESEND.
    typedRendererSteps = [
      { tool: 'confirm_and_run', args: { confirmationToken: rig.session.directConfirmationOffer.token } },
      { speech: 'Running that now.' }
    ];
    let secondResult = null;
    const dispatchAgain = rig.session.dispatchTextToolCall.bind(rig.session);
    rig.session.dispatchTextToolCall = async (...args) => {
      secondResult = await dispatchAgain(...args);
      return secondResult;
    };
    await rig.session.fetch(typedRequest({ text: 'Yes, go ahead.' }));
    rig.session.dispatchTextToolCall = dispatchAgain;
    await settle(rig.durable, rig.session);
    equal(secondResult?.ok, true,
      `approving again must work (${JSON.stringify(secondResult?.code)})`);
    equal(await runCount(rig.meeting), 1, 'exactly once');
    pass('a retry keeps its turn and its place, opens no old authority, and the client can simply agree again');
  }

  /* ---- G1: a correction whose meaning is still being decided ------------- */

  /**
   * NO GAP BETWEEN "NO LONGER PENDING" AND "ITS EFFECT IS IN STATE".
   *
   * An arrival stopped being pending as soon as the server knew WHICH TURN it
   * was. For a reply that answers the delivered plan, that is far too early:
   * whether it was agreement or a correction is decided by the reader, and
   * until that decision comes back nothing has been retired, nothing has been
   * scheduled, and the plan on the table is unchanged only because nobody has
   * looked yet.
   *
   * So an approval arriving behind such a reply found nothing pending, found
   * itself newest, and ran the plan the earlier reply was in the middle of
   * changing. The reply had been READ but not UNDERSTOOD, and the difference is
   * a whole financial decision wide.
   */
  {
    const rig = await typedMeetingWithDeliveredOffer('approval-correction-undecided');
    const CORRECTION = 'Actually, leave my wife\'s pension out of it.';
    approvalScript = {
      [CORRECTION]: { decision: 'semantic_change', reason: 'narrows the plan to one pension' },
      'Yes, go ahead.': { decision: 'pure_approval' }
    };

    // The correction lands and its meaning is still being decided. It blocks
    // before it reaches the renderer, so it takes no scripted step yet.
    const held = holdApprovalReaderFor(CORRECTION);
    typedRendererSteps = [];
    const correctionInFlight = rig.session
      .fetch(typedRequest({ text: CORRECTION })).then((r) => r.json());
    await held.entered;

    // The client then says yes. Its own meaning is decided immediately, so it
    // is the next request to reach the renderer; the correction's reply is
    // queued behind it, for when it is finally released.
    typedRendererSteps = [
      { tool: 'confirm_and_run', args: { confirmationToken: rig.session.directConfirmationOffer.token } },
      { speech: 'Running that now.' },
      { speech: 'Let me take that in.' }
    ];
    let toolResult = null;
    const dispatch = rig.session.dispatchTextToolCall.bind(rig.session);
    rig.session.dispatchTextToolCall = async (...args) => {
      toolResult = await dispatch(...args);
      return toolResult;
    };
    await (await rig.session.fetch(typedRequest({ text: 'Yes, go ahead.' }))).json();
    rig.session.dispatchTextToolCall = dispatch;

    equal(await runCount(rig.meeting), 0,
      'G1: zero engine executions while an earlier reply is still being understood');
    equal(toolResult?.ok, false, 'G1: the approval is refused');
    equal(toolResult?.code, 'client_input_unresolved',
      'G1: refused because something earlier is still being understood, and for no other reason');
    // AND IT WAS THIS MESSAGE THAT WAS READ. A typed reply is bound to the
    // message that asked for it; if it inherited the correction's turn instead,
    // the barrier would have been asking its questions about somebody else's
    // sentence -- and the last reading taken would be the correction's.
    equal(approvalEnvelopes.at(-1).clientReply, 'Yes, go ahead.',
      'G1: the approval was read as itself, not as the message it arrived behind');

    held.release();
    await correctionInFlight;
    await settle(rig.durable, rig.session);
    equal(rig.session.directConfirmationOffer, null,
      'G1: and the correction, once understood, retires the plan it changed');
    equal(await runCount(rig.meeting), 0, 'G1: still nothing has run');
    pass('G1: a reply that has been read but not yet understood still blocks execution');
  }

  /* ---- G2: the same, on the spoken transport ----------------------------- */

  /**
   * The lifecycle is shared, so the hole was too. Asserted separately because
   * the two transports reach it by different routes -- a socket event and an
   * HTTP request -- and a fix that only covered one would look green here.
   */
  {
    const { meeting, simulator, token, session, durable } = await meetingWithDeliveredOffer('approval-correction-undecided-speak');
    const CORRECTION = 'Actually, leave my wife\'s pension out of it.';
    approvalScript = {
      [CORRECTION]: { decision: 'semantic_change', reason: 'narrows the plan to one pension' },
      'Yes, go ahead.': { decision: 'pure_approval' }
    };

    const held = holdApprovalReaderFor(CORRECTION);
    await simulator.send({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_spoken_correction' });
    const correctionInFlight = simulator.send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_spoken_correction',
      transcript: CORRECTION
    });
    await held.entered;

    // The assistant replies to the correction, as the provider would: the
    // reading runs in the background and the meeting keeps talking. Without
    // this the correction's turn would still be waiting for a response and the
    // approval's would inherit it, which is a harness artefact rather than
    // anything a real call does.
    const correctionResponse = await simulator.startResponse();
    await simulator.finishResponse(correctionResponse);

    const approvalItem = 'item_spoken_approval';
    await simulator.send({ type: 'input_audio_buffer.speech_stopped', item_id: approvalItem });
    await simulator.send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: approvalItem,
      transcript: 'Yes, go ahead.'
    });
    const approvalResponse = await simulator.startResponse();
    await simulator.send({
      type: 'response.function_call_arguments.done',
      response_id: approvalResponse.responseId,
      call_id: 'call_spoken_after_correction',
      name: 'confirm_and_run',
      arguments: JSON.stringify({ confirmationToken: token })
    });

    equal(await runCount(meeting), 0,
      'G2: zero engine executions while an earlier spoken reply is still being understood');

    held.release();
    await correctionInFlight;
    await settle(durable, session);
    equal(session.directConfirmationOffer, null,
      'G2: and the spoken correction, once understood, retires the plan it changed');
    equal(await runCount(meeting), 0, 'G2: still nothing has run');
    pass('G2: the same hole is closed on the spoken transport');
  }

  /* ---- G3: an old answer, replayed after the object was rebuilt ---------- */

  /**
   * A DURABLE OBJECT CAN BE REBUILT BETWEEN TWO REQUESTS, and everything it
   * knew about which question a turn answered lived in memory. So a retry
   * carrying a client turn id the conversation had already used was not
   * recognised as a replay at all: it became a brand new turn, and a brand new
   * turn is bound to whatever the assistant asked LAST.
   *
   * The client had said "Yes" to an offer of an explanation. After the rebuild
   * that same "Yes" was answering "shall I run exactly that plan?" -- a
   * question they had never been asked when they said it -- and it ran.
   */
  {
    const meeting = await newLiveMeeting('approval-replay-after-rebuild', {
      CONSUMER_MODULE_PLANNER_MODE: 'apply',
      CONSUMER_TYPED_LANE_ENABLED: 'true',
      OPENAI_API_KEY: 'synthetic-test-key'
    });
    const rig = await attachTypedSession(meeting);
    const REPLAYED_TURN_ID = 'rebuilt-00000001';

    typedRendererSteps = [{ speech: 'Thanks. Would you like me to explain what a balance sheet covers?' }];
    await rig.session.handleTextMessage({ text: POSITION_TURN });
    await settle(rig.durable, rig.session);

    // The answer under test: "Yes", to an offer of an explanation.
    typedRendererSteps = [{ speech: 'It is everything you own and owe in one picture. '
      + 'Roughly how much does your household spend each month?' }];
    await rig.session.handleTextMessage({ text: 'Yes', clientTurnId: REPLAYED_TURN_ID });
    await settle(rig.durable, rig.session);
    const explanationAnswer = [...rig.session.clientTurnsByItemId.values()]
      .find((turn) => turn.itemId === `msg_${REPLAYED_TURN_ID}`);
    const answeredQuestionTurnId = explanationAnswer.answersTurnId;
    ok(answeredQuestionTurnId, 'the "Yes" answered the explanation question');

    typedRendererSteps = [{ speech: 'Okay. Let me line that up.' }];
    await rig.session.handleTextMessage({ text: SPEND_TURN });
    await settle(rig.durable, rig.session);
    typedRendererSteps = [{ tool: 'get_state', args: {} }, { speech: 'Here is the plan.' }];
    const presented = await rig.session.handleTextMessage({ text: SNAPSHOT_TURN });
    await settle(rig.durable, rig.session);
    equal(presented.readback, true, 'the certified plan is put in front of the client');
    const offerToken = rig.session.directConfirmationOffer.token;

    // THE OBJECT IS REBUILT. Everything it knew in memory is gone; everything
    // it wrote down -- including which assistant turn spoke last -- is not.
    const rebuilt = await attachTypedSession(meeting, { initial: Object.fromEntries(rig.durable.values) });
    equal(rebuilt.session.directConfirmationOffer?.token, offerToken,
      'the delivered offer survives the rebuild');
    equal(rebuilt.session.clientTurnsByItemId.size, 0, 'and nothing about the client turns does');

    // The browser, still waiting on a reply it never got, resends that "Yes".
    approvalScript = { Yes: { decision: 'pure_approval' } };
    typedRendererSteps = [
      { tool: 'confirm_and_run', args: { confirmationToken: offerToken } },
      { speech: 'Running that now.' }
    ];
    let toolResult = null;
    const dispatch = rebuilt.session.dispatchTextToolCall.bind(rebuilt.session);
    rebuilt.session.dispatchTextToolCall = async (...args) => {
      toolResult = await dispatch(...args);
      return toolResult;
    };
    await rebuilt.session.fetch(typedRequest({ text: 'Yes', clientTurnId: REPLAYED_TURN_ID }));
    rebuilt.session.dispatchTextToolCall = dispatch;
    await settle(rebuilt.durable, rebuilt.session);

    const replayed = rebuilt.session.clientTurnsByItemId.get(`msg_${REPLAYED_TURN_ID}`);
    equal(replayed?.answersTurnId, answeredQuestionTurnId,
      'G3: a replayed turn still answers the question it originally answered');
    equal(replayed?.ordinal, 0,
      'G3: and takes no place in the conversation, because it is not a new thing said');
    equal(toolResult?.ok, false, 'G3: so it carries no authority over the current offer');
    equal(await runCount(meeting), 0,
      'G3: zero engine executions from an old answer rebound to a newer question');
    pass('G3: rebuilding the meeting cannot repoint an old answer at a question it never heard');
  }

  /* ---- G4: a replayed answer that DID answer the offer, after a rebuild --- */

  /**
   * THE HALF OF G3 THAT THE PROPOSITION ALONE DOES NOT COVER.
   *
   * There, the replayed answer had been given to a different question, and
   * keeping that question was enough to make it harmless. Here it was given to
   * the read-back itself -- so restoring its proposition faithfully restores an
   * answer that IS about the plan on the table.
   *
   * It must still not run. A message the client sent before the rebuild is not
   * something they have just done, and a plan runs on what they have just done.
   * The replay carries its identity and no authority; the way back is the
   * client agreeing again, which is a turn of their own, and that still works.
   */
  {
    const meeting = await newLiveMeeting('approval-replay-answered-the-offer', {
      CONSUMER_MODULE_PLANNER_MODE: 'apply',
      CONSUMER_TYPED_LANE_ENABLED: 'true',
      OPENAI_API_KEY: 'synthetic-test-key'
    });
    const rig = await attachTypedSession(meeting);
    const REPLAYED_TURN_ID = 'answered-offer-01';

    typedRendererSteps = [{ speech: 'Thanks. Roughly how much do you spend each month?' }];
    await rig.session.handleTextMessage({ text: POSITION_TURN });
    await settle(rig.durable, rig.session);
    typedRendererSteps = [{ speech: 'Okay. Let me line that up.' }];
    await rig.session.handleTextMessage({ text: SPEND_TURN });
    await settle(rig.durable, rig.session);
    typedRendererSteps = [{ tool: 'get_state', args: {} }, { speech: 'Here is the plan.' }];
    const presented = await rig.session.handleTextMessage({ text: SNAPSHOT_TURN });
    await settle(rig.durable, rig.session);
    equal(presented.readback, true, 'the certified plan is put in front of the client');
    const offerToken = rig.session.directConfirmationOffer.token;

    // They agree -- and the reply carrying that agreement is lost.
    approvalScript = { 'Yes, go ahead.': { decision: 'pure_approval' } };
    typedRendererSteps = [{ speech: 'Sorry, something went wrong there.' }];
    await rig.session.handleTextMessage({ text: 'Yes, go ahead.', clientTurnId: REPLAYED_TURN_ID });
    await settle(rig.durable, rig.session);
    equal(await runCount(meeting), 0, 'nothing ran');
    const originalProposition = rig.session.clientTurnsByItemId
      .get(`msg_${REPLAYED_TURN_ID}`).answersTurnId;

    // The object is rebuilt, and the browser resends that agreement.
    const rebuilt = await attachTypedSession(meeting, { initial: Object.fromEntries(rig.durable.values) });
    typedRendererSteps = [
      { tool: 'confirm_and_run', args: { confirmationToken: offerToken } },
      { speech: 'Running that now.' }
    ];
    let replayResult = null;
    const dispatch = rebuilt.session.dispatchTextToolCall.bind(rebuilt.session);
    rebuilt.session.dispatchTextToolCall = async (...args) => {
      replayResult = await dispatch(...args);
      return replayResult;
    };
    await rebuilt.session.fetch(typedRequest({ text: 'Yes, go ahead.', clientTurnId: REPLAYED_TURN_ID }));
    await settle(rebuilt.durable, rebuilt.session);

    const replayed = rebuilt.session.clientTurnsByItemId.get(`msg_${REPLAYED_TURN_ID}`);
    equal(replayed?.answersTurnId, originalProposition,
      'G4: the replay keeps the proposition it answered, which here really was the offer');
    // TWO INDEPENDENT REASONS IT CANNOT RUN, and both are meant. There is
    // nothing of the client's to read for this turn -- a replay carries no
    // fresh words -- and it is not something they have just done. The second is
    // the one that would still hold if the first ever stopped being true.
    equal(replayed?.ordinal, 0,
      'G4: and is not something the client has just done, whatever it says');
    equal(replayResult?.ok, false, 'G4: and still carries no authority to run it');
    equal(await runCount(meeting), 0,
      'G4: zero engine executions from an answer the client gave before the rebuild');

    // AND THE WAY BACK STILL WORKS. Agreeing again is a turn of their own.
    typedRendererSteps = [
      { tool: 'confirm_and_run', args: { confirmationToken: offerToken } },
      { speech: 'Running that now.' }
    ];
    let freshResult = null;
    rebuilt.session.dispatchTextToolCall = async (...args) => {
      freshResult = await dispatch(...args);
      return freshResult;
    };
    await rebuilt.session.fetch(typedRequest({ text: 'Yes, go ahead.' }));
    rebuilt.session.dispatchTextToolCall = dispatch;
    await settle(rebuilt.durable, rebuilt.session);
    equal(freshResult?.ok, true,
      `G4: agreeing again after a rebuild must work (${JSON.stringify(freshResult?.code)})`);
    equal(await runCount(meeting), 1, 'G4: exactly once');
    pass('G4: a rebuilt meeting will not run an answer the client gave before it was rebuilt');
  }

  /* ===================== Astra's fourth review: four more ================== */

  /* --- H1: the client answers the question they were shown ---------------- */

  /**
   * TWO REPLIES TO ONE MESSAGE, AND THE CLIENT ONLY EVER SAW ONE.
   *
   * A typed request can be lost after the server has done the work. The
   * browser resends, and for a moment two requests are answering the same
   * message. Each opened its own reply, each wrote its own assistant turn, and
   * whichever finished LAST became the proposition the client's next answer
   * would be read against -- whether or not it was the one they were shown.
   *
   * So the client is shown "would you like me to explain what that covers?",
   * says "Yes", and that Yes is read against a plan read-back they never saw.
   */
  {
    const rig = await typedMeetingWithDeliveredOffer('approval-two-replies-one-message');
    const RESENT_ID = 'tworeplies-000001';
    const QUESTION_THEY_SAW = 'Would you like me to explain what that covers?';

    // The original request is held inside its own work. Its reply will be the
    // certified read-back -- a proposition the client is never going to see,
    // because this request's answer is the one that gets lost.
    const assistantTurnsBefore = await assistantTurnCount(rig.meeting);
    const gate = rig.interleave.gateOnce(/INSERT INTO consumer_realtime_events/i);
    // One reply is scripted for the client to see. The second is the one the
    // late request would have written if it were allowed to write its own.
    typedRendererSteps = [
      { speech: QUESTION_THEY_SAW },
      { speech: 'Shall I run exactly that plan now?' }
    ];
    const original = rig.session
      .fetch(typedRequest({ text: 'What does that cover?', clientTurnId: RESENT_ID }))
      .then((r) => r.json());
    await gate.arrived;

    // The browser gives up and resends. This is the reply the client reads.
    const resent = await (await rig.session
      .fetch(typedRequest({ text: 'What does that cover?', clientTurnId: RESENT_ID }))).json();

    gate.release();
    const originalReply = await original;
    await settle(rig.durable, rig.session);

    // COMMITTED, NOT MERELY LAST. The point is not that some ordering rule
    // picks a winner afterwards -- it is that there was never more than one
    // thing to pick. One message, one assistant turn written, and every request
    // that answers that message hands back those same words. Whatever reached
    // the client's screen, it was this proposition, because no other existed.
    equal(await assistantTurnCount(rig.meeting) - assistantTurnsBefore, 1,
      'H1: one client message commits exactly one assistant turn, however many requests ask for it');
    equal(resent.assistantText, QUESTION_THEY_SAW,
      'H1: the client was shown the reply their resend came back with');
    equal(originalReply.assistantText, resent.assistantText,
      'H1: and both requests answering one message carry the same proposition');
    equal(originalReply.turnId, resent.turnId, 'H1: and name the same client turn');
    equal(typedRendererSteps.length, 1,
      'H1: the reply the late request would have written was never written');

    // They answer the question they were shown -- and the reader answers the
    // question IT is shown, which is the whole hazard: a competent reading of
    // "Yes" is agreement to run the plan only if the utterance it answered was
    // asking that. Nothing about the words settles it.
    approvalScript = {
      Yes: (envelope) => (/run exactly that plan/i.test(envelope?.answeredUtterance?.text || '')
        ? { decision: 'pure_approval', proposition: 'offer' }
        : { decision: 'pure_approval', proposition: 'other_assistant_question' })
    };
    typedRendererSteps = [
      { tool: 'confirm_and_run', args: { confirmationToken: rig.session.directConfirmationOffer?.token || 'gone' } },
      { speech: 'Running that now.' }
    ];
    let toolResult = null;
    const dispatch = rig.session.dispatchTextToolCall.bind(rig.session);
    rig.session.dispatchTextToolCall = async (...args) => {
      toolResult = await dispatch(...args);
      return toolResult;
    };
    await rig.session.fetch(typedRequest({ text: 'Yes' }));
    rig.session.dispatchTextToolCall = dispatch;
    await settle(rig.durable, rig.session);

    equal(toolResult?.ok, false,
      'H1: agreeing to the question they were shown does not run a plan they were not');
    equal(await runCount(rig.meeting), 0, 'H1: zero engine executions');
    pass('H1: one client message commits one proposition, and a late reply cannot replace it');
  }

  /* --- H2: a replay landing on top of live semantic work ------------------ */

  /**
   * THE LOOKUP THAT CHECKED LIVE STATE, THEN WENT AWAY AND CAME BACK.
   *
   * Adoption asked "is there a live turn for this message?" before awaiting
   * the durable record, and acted on that answer afterwards. In between, a
   * correction with the same id could arrive, become a live turn, and acquire
   * an unresolved meaning -- and adoption would then replace it with a
   * finished, historical turn and release the hold its meaning was still
   * sitting behind.
   */
  {
    const rig = await typedMeetingWithDeliveredOffer('approval-adoption-races-correction');
    const SHARED_ID = 'adoptrace-000001';
    const CORRECTION = 'Actually, leave my wife\'s pension out of it.';
    approvalScript = {
      [CORRECTION]: { decision: 'semantic_change', reason: 'narrows the plan to one pension' },
      'Yes, go ahead.': { decision: 'pure_approval' }
    };

    // A replay request reaches its identity lookup and is held there.
    const lookupGate = rig.interleave.gateOnce(
      /SELECT id, answers_turn_id, meeting_sequence FROM consumer_realtime_final_turns/i
    );
    typedRendererSteps = [];
    const replay = rig.session
      .fetch(typedRequest({ text: CORRECTION, clientTurnId: SHARED_ID }))
      .then((r) => r.json()).catch(() => null);
    await lookupGate.arrived;

    // While it is held, the same message arrives again and becomes a live turn
    // whose meaning is still being decided.
    const held = holdApprovalReaderFor(CORRECTION);
    const live = rig.session
      .fetch(typedRequest({ text: CORRECTION, clientTurnId: SHARED_ID }))
      .then((r) => r.json()).catch(() => null);
    await held.entered;

    // The replies, in the order the requests will actually reach the renderer.
    // Both requests for the correction are held behind its undecided meaning --
    // one waiting on the reader, the other adopting its reply -- so the
    // approval is the first to render, and the correction's single reply
    // follows when its meaning is released.
    typedRendererSteps = [
      { tool: 'confirm_and_run', args: { confirmationToken: rig.session.directConfirmationOffer.token } },
      { speech: 'Running that now.' },
      { speech: 'Let me take that in.' }
    ];

    // The lookup returns. It must not bury the live turn it now finds.
    lookupGate.release();
    await new Promise((resolve) => setImmediate(resolve));
    const sharedItem = `msg_${SHARED_ID}`;
    const stillLive = rig.session.clientTurnsByItemId.get(sharedItem);
    equal(stillLive?.replayedFromRecord, undefined,
      'H2: the live turn is still the live turn, not a historical one written over it');
    ok([...rig.session.pendingClientInput.keys()].length > 0,
      'H2: and the hold its undecided meaning owns is still in place');
    let toolResult = null;
    const dispatch = rig.session.dispatchTextToolCall.bind(rig.session);
    rig.session.dispatchTextToolCall = async (...args) => {
      toolResult = await dispatch(...args);
      return toolResult;
    };
    await rig.session.fetch(typedRequest({ text: 'Yes, go ahead.' }));
    rig.session.dispatchTextToolCall = dispatch;

    equal(await runCount(rig.meeting), 0,
      'H2: zero engine executions while a correction adoption raced is still undecided');
    equal(toolResult?.ok, false, 'H2: the approval is refused');

    held.release();
    await Promise.all([replay, live]);
    await settle(rig.durable, rig.session);
    equal(await runCount(rig.meeting), 0, 'H2: and nothing runs once it settles');
    pass('H2: durable adoption cannot bury a live turn that gained meaning while it looked');
  }

  /* --- H3: the identity lookup fails, which is not the same as absent ----- */

  /**
   * "I DO NOT KNOW" IS NOT "THERE IS NOTHING".
   *
   * A failed SELECT was caught and read as proof that this message had never
   * been a turn -- so a replay after a rebuild became a brand new turn, bound
   * to whatever the assistant had asked last, and carried an old answer into a
   * question it had never been asked.
   */
  {
    const meeting = await newLiveMeeting('approval-replay-lookup-fails', {
      CONSUMER_MODULE_PLANNER_MODE: 'apply',
      CONSUMER_TYPED_LANE_ENABLED: 'true',
      OPENAI_API_KEY: 'synthetic-test-key'
    });
    const interleave = interleavingDatabase(meeting.env.CONSUMER_DB);
    meeting.env.CONSUMER_DB = interleave.database;
    const rig = await attachTypedSession(meeting);
    const REPLAYED_ID = 'lookupfail-000001';

    typedRendererSteps = [{ speech: 'Thanks. Would you like me to explain what a balance sheet covers?' }];
    await rig.session.handleTextMessage({ text: POSITION_TURN });
    await settle(rig.durable, rig.session);
    typedRendererSteps = [{ speech: 'It is everything you own and owe. Roughly how much do you spend each month?' }];
    await rig.session.handleTextMessage({ text: 'Yes', clientTurnId: REPLAYED_ID });
    await settle(rig.durable, rig.session);
    typedRendererSteps = [{ speech: 'Okay. Let me line that up.' }];
    await rig.session.handleTextMessage({ text: SPEND_TURN });
    await settle(rig.durable, rig.session);
    typedRendererSteps = [{ tool: 'get_state', args: {} }, { speech: 'Here is the plan.' }];
    const presented = await rig.session.handleTextMessage({ text: SNAPSHOT_TURN });
    await settle(rig.durable, rig.session);
    equal(presented.readback, true, 'the certified plan is put in front of the client');
    const offerToken = rig.session.directConfirmationOffer.token;

    const rebuilt = await attachTypedSession(meeting, { initial: Object.fromEntries(rig.durable.values) });
    approvalScript = { Yes: { decision: 'pure_approval' } };
    // Storage cannot answer whether this message is already a turn.
    interleave.failOnce(
      /SELECT id, answers_turn_id, meeting_sequence FROM consumer_realtime_final_turns/i
    );
    typedRendererSteps = [
      { tool: 'confirm_and_run', args: { confirmationToken: offerToken } },
      { speech: 'Running that now.' }
    ];
    let toolResult = null;
    const dispatch = rebuilt.session.dispatchTextToolCall.bind(rebuilt.session);
    rebuilt.session.dispatchTextToolCall = async (...args) => {
      toolResult = await dispatch(...args);
      return toolResult;
    };
    const replayed = await (await rebuilt.session
      .fetch(typedRequest({ text: 'Yes', clientTurnId: REPLAYED_ID }))).json();
    rebuilt.session.dispatchTextToolCall = dispatch;
    await settle(rebuilt.durable, rebuilt.session);

    equal(replayed.ok, false,
      'H3: a message whose identity storage could not confirm is refused, not adopted as new');
    equal(await runCount(meeting), 0,
      'H3: zero engine executions when identity is unknown rather than known absent');
    pass('H3: a failed identity lookup blocks, because unknown is not absent');
  }

  /* --- H4: the client spoke, and the server could not write it down ------- */

  /**
   * INPUT THAT CANNOT BE PERSISTED HAS STILL HAPPENED.
   *
   * The hold on an arrival was installed alongside the turn's planning
   * obligation, and that obligation needs a stored turn id. When the write
   * failed there was no id, so no obligation, so no hold -- and the arrival was
   * released even though nothing had been decided about what the client said.
   * The correction vanished from execution safety state precisely because the
   * server could not record it.
   */
  {
    const meeting = await newLiveMeeting('approval-persistence-fails-speak', {
      CONSUMER_MODULE_PLANNER_MODE: 'apply',
      OPENAI_API_KEY: 'synthetic-test-key'
    });
    const interleave = interleavingDatabase(meeting.env.CONSUMER_DB);
    meeting.env.CONSUMER_DB = interleave.database;
    const rig = await attachLiveSession(meeting);
    const simulator = new LiveProviderSimulator(rig);
    const { session, durable } = rig;

    await simulator.turn({ clientText: POSITION_TURN, act: async () => ({ speech: 'Thanks. Roughly how much a month?' }) });
    await settle(durable, session);
    await simulator.turn({ clientText: SPEND_TURN, act: async () => ({ speech: 'Okay. Let me line that up.' }) });
    await settle(durable, session);
    let token = null;
    await simulator.turn({
      clientText: SNAPSHOT_TURN,
      act: async ({ callTool }) => {
        const state = await callTool('get_state', {});
        token = state.result?.confirmationToken || null;
        return { speech: state.result.confirmationPrompt };
      }
    });
    await settle(durable, session);
    ok(token, 'the spoken meeting reaches a delivered certified offer');

    // The client corrects the plan, and the write of their words fails.
    const CORRECTION = 'Actually, leave my wife\'s pension out of it.';
    approvalScript = {
      [CORRECTION]: { decision: 'semantic_change', reason: 'narrows the plan to one pension' },
      'Yes, go ahead.': { decision: 'pure_approval' }
    };
    interleave.failOnce(/INSERT INTO consumer_realtime_final_turns/i);
    await simulator.send({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_unwritable_correction' });
    await simulator.send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_unwritable_correction',
      transcript: CORRECTION
    });
    const correctionResponse = await simulator.startResponse();
    await simulator.finishResponse(correctionResponse);

    // They then say yes.
    await simulator.send({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_after_unwritable' });
    await simulator.send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_after_unwritable',
      transcript: 'Yes, go ahead.'
    });
    const approvalResponse = await simulator.startResponse();
    await simulator.send({
      type: 'response.function_call_arguments.done',
      response_id: approvalResponse.responseId,
      call_id: 'call_after_unwritable',
      name: 'confirm_and_run',
      arguments: JSON.stringify({ confirmationToken: token })
    });
    await settle(durable, session);

    equal(await runCount(meeting), 0,
      'H4: zero engine executions after client input the server could not write down');
    pass('H4: input that cannot be persisted still holds execution closed');
  }

  /* --- H5: the ordinary paths still work, on both transports ------------- */

  /**
   * THE CONTROL FOR ALL FOUR. Every fix above closes something, and a barrier
   * that closes everything is not a barrier, it is a wall. So: a typed meeting
   * and a spoken meeting, each run straight through, each approving once, each
   * buying nothing extra from the planner or the verifier -- and a second
   * identical request to each still joining the receipt rather than starting a
   * second analysis.
   */
  for (const transport of ['type', 'speak']) {
    approvalScript = { 'Yes, go ahead.': { decision: 'pure_approval' } };

    if (transport === 'type') {
      const rig = await typedMeetingWithDeliveredOffer('approval-ordinary-type');
      // Counted across the approval turn, not across the whole meeting: the
      // three passes that certified the plan are the point of the plan.
      const extractionsBefore = extractionCalls;
      const verificationsBefore = verificationCalls;
      typedRendererSteps = [
        { tool: 'confirm_and_run', args: { confirmationToken: rig.session.directConfirmationOffer.token } },
        { speech: 'Running that now.' }
      ];
      let result = null;
      const dispatch = rig.session.dispatchTextToolCall.bind(rig.session);
      rig.session.dispatchTextToolCall = async (...args) => {
        result = await dispatch(...args);
        return result;
      };
      await rig.session.fetch(typedRequest({ text: 'Yes, go ahead.', clientTurnId: 'ordinary-typed-01' }));
      await settle(rig.durable, rig.session);
      equal(result?.ok, true, `H5: an ordinary typed approval executes (${JSON.stringify(result?.code)})`);
      equal(await runCount(rig.meeting), 1, 'H5: exactly once');
      equal(extractionCalls - extractionsBefore, 0, 'H5: with no planner pass');
      equal(verificationCalls - verificationsBefore, 0, 'H5: and no verifier pass');

      // The same message again: idempotent, and one proposition still.
      const repeated = await (await rig.session
        .fetch(typedRequest({ text: 'Yes, go ahead.', clientTurnId: 'ordinary-typed-01' }))).json();
      rig.session.dispatchTextToolCall = dispatch;
      await settle(rig.durable, rig.session);
      equal(repeated.ok, true, 'H5: resending it is answered');
      equal(await runCount(rig.meeting), 1, 'H5: and runs nothing a second time');
    } else {
      const { meeting, simulator, token, session, durable } = await meetingWithDeliveredOffer('approval-ordinary-speak');
      const extractionsBefore = extractionCalls;
      const verificationsBefore = verificationCalls;
      let result = null;
      await simulator.turn({
        clientText: 'Yes, go ahead.',
        act: async ({ callTool, speak }) => {
          result = (await callTool('confirm_and_run', { confirmationToken: token })).result;
          await speak(result?.speakableText || 'Running that now.');
          return { alreadySpoken: true };
        }
      });
      await settle(durable, session);
      equal(result?.ok, true, `H5: an ordinary spoken approval executes (${JSON.stringify(result?.code)})`);
      equal(await runCount(meeting), 1, 'H5: exactly once');
      equal(extractionCalls - extractionsBefore, 0, 'H5: with no planner pass');
      equal(verificationCalls - verificationsBefore, 0, 'H5: and no verifier pass');
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
      equal(await runCount(meeting), 1, 'H5: and a duplicate approval runs nothing again');
      ok(duplicate, 'H5: the duplicate is answered rather than dropped');
    }
    pass(`H5: the ordinary ${transport} path still works end to end`);
  }

  /* --- H6: a correction still needs fresh certification ------------------- */

  /**
   * And the other direction: a reply that changes the plan must still retire
   * it and require the whole loop again, on the transport where three of these
   * fixes live.
   */
  {
    const rig = await typedMeetingWithDeliveredOffer('approval-correction-still-recertifies');
    const CORRECTION = 'Actually, leave my wife\'s pension out of it.';
    approvalScript = {
      [CORRECTION]: { decision: 'semantic_change', reason: 'narrows the plan to one pension' },
      'Yes, go ahead.': { decision: 'pure_approval' }
    };
    const extractionsBefore = extractionCalls;
    typedRendererSteps = [{ speech: 'Understood -- leaving that out.' }];
    await rig.session.fetch(typedRequest({ text: CORRECTION }));
    await settle(rig.durable, rig.session);
    equal(rig.session.directConfirmationOffer, null,
      'H6: a correction retires the certified plan');
    ok(extractionCalls > extractionsBefore,
      'H6: and sends the conversation back through interpretation');

    typedRendererSteps = [
      { tool: 'confirm_and_run', args: { confirmationToken: 'dmc_the_retired_one' } },
      { speech: 'Let me read the new plan back.' }
    ];
    let refused = null;
    const dispatch = rig.session.dispatchTextToolCall.bind(rig.session);
    rig.session.dispatchTextToolCall = async (...args) => {
      refused = await dispatch(...args);
      return refused;
    };
    await rig.session.fetch(typedRequest({ text: 'Yes, go ahead.' }));
    rig.session.dispatchTextToolCall = dispatch;
    await settle(rig.durable, rig.session);
    equal(refused?.ok, false, 'H6: and nothing can be approved until a new plan is certified');
    equal(await runCount(rig.meeting), 0, 'H6: zero engine executions');
    pass('H6: a correction still retires the plan and requires fresh certification');
  }

  /* ------------------ currency and order cannot move backwards, ever ------- */

  /**
   * THE PROPERTY, ASSERTED DIRECTLY RATHER THAN THROUGH A SCHEDULE.
   *
   * Every failure Astra has found at this boundary has been an instance of one
   * thing: something that had arrived stopped counting. So the counter is
   * driven through every shape a request can take -- delivered, retried, empty,
   * malformed, dropped mid-body, a reused id, a rejected one -- and asserted to
   * be non-decreasing throughout, with no path that lowers it.
   */
  {
    const rig = await typedMeetingWithDeliveredOffer('approval-monotonic-clock');
    const seen = [rig.session.clientInputSequence];
    const record = () => seen.push(rig.session.clientInputSequence);

    typedRendererSteps = [{ speech: 'Understood.' }];
    await rig.session.fetch(typedRequest({ text: 'One.', clientTurnId: 'mono-000000000001' }));
    await settle(rig.durable, rig.session); record();
    typedRendererSteps = [{ speech: 'Understood.' }];
    await rig.session.fetch(typedRequest({ text: 'One.', clientTurnId: 'mono-000000000001' }));
    await settle(rig.durable, rig.session); record();
    await rig.session.fetch(typedRequest({ text: '' })); record();
    await rig.session.fetch(new Request('http://live-session/message', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json at all'
    })); record();
    {
      const dropped = suspendedTypedRequest({ text: 'never arrives' });
      const inFlight = rig.session.fetch(dropped.request).then((r) => r.json()).catch(() => null);
      dropped.fail();
      await inFlight; record();
    }
    typedRendererSteps = [{ speech: 'Understood.' }];
    await rig.session.fetch(typedRequest({ text: 'Two.' }));
    await settle(rig.durable, rig.session); record();

    equal(seen, [...seen].sort((left, right) => left - right),
      'the client-input sequence never decreases, whatever a request turns out to be');
    equal(seen.slice(1).every((value, index) => value > seen[index]), true,
      'and every one of those requests spent a sequence, including the ones that carried nothing');
    equal(rig.session.pendingClientInput.size, 0,
      'and every one of those requests settled: nothing is left holding the meeting closed');
    pass('arrival is monotonic across delivery, retry, rejection, malformation and failure');
  }
}

/* ------------- unresolved earlier speech holds a later approval closed ----- */

/**
 * THE SAME ORDERING, ON THE OTHER TRANSPORT.
 *
 * Transcription does not complete in the order speech began. So a client can
 * start saying something, start saying something else, and have the SECOND
 * utterance transcribed first -- and if that second one is an approval, it is
 * genuinely the newest thing they did while the first is still unknown.
 *
 * Being newest is not enough. Both halves are asserted: held while the earlier
 * utterance is unaccounted for, and released once the server establishes that
 * it carried nothing usable, because then there is nothing left to incorporate.
 */
{
  const { meeting, simulator, token, session, durable } = await meetingWithDeliveredOffer('approval-unresolved-earlier-speech');
  approvalScript = { 'Yes, go ahead.': { decision: 'pure_approval' } };

  // The client starts saying something. Nothing is transcribed yet.
  await simulator.send({ type: 'input_audio_buffer.speech_started', item_id: 'item_earlier_speech' });
  await simulator.send({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_earlier_speech' });

  // They then say something else, and ASR lands THAT one first.
  const approvalItem = 'item_later_approval';
  await simulator.send({ type: 'input_audio_buffer.speech_stopped', item_id: approvalItem });
  await simulator.send({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: approvalItem,
    transcript: 'Yes, go ahead.'
  });
  const approvalTurn = session.clientTurnsByItemId.get(approvalItem);
  equal(approvalTurn.ordinal, session.clientInputSequence,
    'the approval really is the newest thing the client did');
  ok([...session.pendingClientInput.keys()].some((sequence) => sequence < approvalTurn.ordinal),
    'and something they said before it is still unaccounted for');

  const firstResponse = await simulator.startResponse();
  await simulator.send({
    type: 'response.function_call_arguments.done',
    response_id: firstResponse.responseId,
    call_id: 'call_blocked_by_earlier',
    name: 'confirm_and_run',
    arguments: JSON.stringify({ confirmationToken: token })
  });
  await settle(durable, session);
  equal(await runCount(meeting), 0,
    'zero engine executions while an earlier utterance is still unaccounted for');
  pass('being the newest thing said does not let an approval step over unread speech');

  // The earlier utterance turns out to be unusable. There is nothing to
  // incorporate, so there is nothing left to wait for.
  await simulator.send({
    type: 'conversation.item.input_audio_transcription.failed',
    item_id: 'item_earlier_speech'
  });
  await settle(durable, session);
  equal(session.pendingClientInput.size, 0, 'and the meeting is no longer holding anything');

  const secondResponse = await simulator.startResponse();
  await simulator.send({
    type: 'response.function_call_arguments.done',
    response_id: secondResponse.responseId,
    call_id: 'call_after_earlier_resolved',
    name: 'confirm_and_run',
    arguments: JSON.stringify({ confirmationToken: token })
  });
  await settle(durable, session);
  equal(await runCount(meeting), 1,
    'once that earlier utterance is known to carry nothing, the approval runs');
  pass('an unresolved earlier utterance holds an approval closed, and releases it when settled');
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
  const before = session.clientInputSequence;
  const itemId = 'item_single_utterance';
  await simulator.send({ type: 'input_audio_buffer.speech_started', item_id: itemId });
  await simulator.send({ type: 'input_audio_buffer.speech_stopped', item_id: itemId });
  await simulator.send({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript: 'Yes, go ahead.'
  });
  equal(session.clientInputSequence - before, 1,
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
