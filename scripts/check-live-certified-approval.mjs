#!/usr/bin/env node

/**
 * PRODUCTION REGRESSION: meeting rt_boV2WphUTX5n52pYqtlaiJn-, 2026-09-05.
 *
 * A client with a new baby asked for a general financial check-up, gave their
 * whole position, heard the certified plan read back, and approved it. Nothing
 * ran. They asked "Any updates?" three times and hung up.
 *
 * WHAT PRODUCTION ACTUALLY DID, reconstructed from the unencrypted D1 ledger:
 *
 *   12:22:32.640  planner pass -> verifier PASS -> certificate issued
 *   12:22:32.923  get_state prepares realtime_plan_euC2dDd0-T1LlJctpU2alWI5
 *   12:22:38.718  the certified prompt is spoken verbatim (equality-enforced)
 *   12:22:59.523  the client approves: "Ja."
 *   12:23:00.595  "Perfect, thanks for confirming. Let me get that started."
 *   12:23:00.788  confirm_and_run -> REJECTED, confirmation_required
 *   12:23:15.811  the pass scheduled BY that unrecognised approval turn runs;
 *                 the verifier reverses itself and the offer is destroyed
 *   ...           no certificate is ever issued again; the call ends
 *
 * The rejected result is cryptographically identified: its stored
 * result_hash_b64u, SlPnqUgW_rYon_V6SGttfM89PtjpkFYZOjuJurWsjm0, is the
 * SHA-256 of the classifier's early return and of nothing else in that
 * function. The transcript hashes are unsalted SHA-256 of the turn text, so
 * turn 26 is confirmed as exactly "Ja.".
 *
 * TWO DEFECTS COMPOSE, AND EITHER ONE ALONE IS SURVIVABLE.
 *
 *   A. classifyExecutionApproval does not recognise the approval, so
 *      confirm_and_run refuses it.
 *   B. BECAUSE it was not recognised, the approval turn is treated as ordinary
 *      evidence and schedules a planning pass. `confirmsPublishedDirectSnapshot`
 *      skips that pass only for an `affirmed` turn -- exactly so an approval
 *      cannot invalidate the plan it is approving. That pass re-ran the
 *      verifier over evidence that had gained nothing but the read-back and
 *      the word "Ja.", got a different verdict, and destroyed a certificate
 *      the client had already heard and accepted.
 *
 * A false negative was designed to cost one clarification. Because of B it
 * costs the meeting.
 *
 * This runs the real Durable Object over a real local D1: real transcript
 * storage, real detached planning, real encrypted brief, real certificate,
 * real confirmation barrier, real deterministic module execution. Only the two
 * model responses are scripted -- and the verifier is scripted to REVERSE
 * ITSELF exactly as production's did, because that reversal is the defect.
 *
 * FREE. No provider, no network, no production writes.
 */

import assert from 'node:assert/strict';

import { attachLiveSession, newLiveMeeting, settle } from './live-harness/session.mjs';
import { LiveProviderSimulator } from './live-harness/provider.mjs';
import {
  DIRECT_MODULE_CONTRACTS,
  DIRECT_MODULE_IDS,
  MODULE_PLANNING_SNAPSHOT_V1
} from '../worker/src/consumer/direct_module_planner.js';
import {
  APPROVAL_DECISION_SCHEMA_NAME,
  approvalDecisionResponse,
  scriptedApprovalDecision
} from './live-harness/approval-script.mjs';

const pass = (message) => console.info(`[CertifiedApproval] PASS: ${message}`);
let checks = 0;
const ok = (value, message) => { checks += 1; assert.ok(value, message); };
const equal = (actual, expected, message) => { checks += 1; assert.deepEqual(actual, expected, message); };

/* ------------------------------------------------ the call, as it happened */

// Sanitised to what the client actually said. No name, no contact detail, no
// figure they did not speak.
const POSITION_TURN = 'So I currently have 80,000 euro in cash along with my wife. We have that saved '
  + 'up in a bank account. In addition to that, we have our house now, which is worth 500,000 euro, '
  + 'of which there is a 300,000 euro mortgage on it. We have pensions. My pension is 50,000 euro and '
  + 'her pension is 30,000 euro. And I have 2,000 euro just in my Degiro account in Apple shares.';
const SPEND_TURN = 'Spend about 4,000 euro a month including the mortgage.';
const SNAPSHOT_ONLY_TURN = 'I think I am happy to just look at the overall snapshot for now.';

// The exact utterance. Whisper produced this for the client's approval, and its
// SHA-256 matches production turn realtime_turn_jQ16AAdIbpoGBH-zs7BOImwX.
const APPROVAL = 'Ja.';

// The certified prompt, in the shape the planner produced it: PBS only, the
// retirement projection deferred, ownership narrated.
const CONFIRMATION_PROMPT = 'I will run the overall financial snapshot using your and your wife’s '
  + '€80,000 joint savings, jointly owned €500,000 home with a €300,000 mortgage, your '
  + '€50,000 pension, her €30,000 pension, €2,000 in your Apple shares, no other debts, '
  + 'and about €4,000 monthly household spending. I will leave the retirement projection for later. '
  + 'Does that sound right, and shall I run exactly that plan?';

const PBS_INPUT = Object.freeze({
  currency: 'EUR',
  assetPositions: [
    { id: 'cash', label: 'Joint savings', bucket: 'spendable_reserves', amount: 80000, source: 'assets' },
    { id: 'home', label: 'Family home', bucket: 'lifestyle_assets', amount: 500000, source: 'properties' },
    { id: 'pension-primary', label: 'Your pension', bucket: 'retirement_funding', amount: 50000, source: 'pensions' },
    { id: 'pension-partner', label: 'Your wife’s pension', bucket: 'retirement_funding', amount: 30000, source: 'pensions' },
    { id: 'shares', label: 'Apple shares', bucket: 'concentrated_assets', amount: 2000, source: 'assets' }
  ],
  liabilityPositions: [{ id: 'mortgage', label: 'Mortgage', amount: 300000, source: 'liabilities' }],
  monthlyExpenditure: 4000,
  reconciliationWarnings: [],
  currencyWarnings: []
});

/* ------------------------------------------------------- scripted planner */

let extractionCalls = 0;
let verificationCalls = 0;
let approvalCalls = 0;
const approvalEnvelopes = [];

/**
 * The extractor never wavers. In production it produced a ready snapshot on
 * every pass from 12:22:13 onward -- that is why the verifier ran every time.
 */
function extractionFor(throughTurnId, baseSnapshotRevision, evidenceTurnId, spendTurnId) {
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
        ? 'Overall snapshot: €80,000 joint savings, €500,000 home, €300,000 mortgage, '
          + '€50,000 and €30,000 pensions, €2,000 shares, €4,000 monthly spending.'
        : '',
      selection: moduleId === 'personal_balance_sheet'
        ? { origin: 'client_requested', reason: 'They asked for an overall snapshot of where they stand.' }
        : { origin: 'not_selected', reason: 'Not asked for today.' },
      missing: [],
      ambiguities: [],
      assumptions: [],
      resolvedAcknowledgedUnknown: [],
      evidence: moduleId === 'personal_balance_sheet' ? [
        { path: '/assetPositions/0', source: 'conversation', turnId: evidenceTurnId, quote: '80,000 euro in cash along with my wife', profilePath: '' },
        { path: '/assetPositions/1', source: 'conversation', turnId: evidenceTurnId, quote: 'we have our house now, which is worth 500,000 euro', profilePath: '' },
        { path: '/assetPositions/2', source: 'conversation', turnId: evidenceTurnId, quote: 'My pension is 50,000 euro', profilePath: '' },
        { path: '/assetPositions/3', source: 'conversation', turnId: evidenceTurnId, quote: 'her pension is 30,000 euro', profilePath: '' },
        { path: '/assetPositions/4', source: 'conversation', turnId: evidenceTurnId, quote: '2,000 euro just in my Degiro account in Apple shares', profilePath: '' },
        { path: '/liabilityPositions/0', source: 'conversation', turnId: evidenceTurnId, quote: 'there is a 300,000 euro mortgage on it', profilePath: '' },
        { path: '/monthlyExpenditure', source: 'conversation', turnId: spendTurnId, quote: 'about 4,000 euro a month', profilePath: '' }
      ] : []
    }))
  };
}

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

/**
 * THE PRODUCTION REVERSAL. On identical evidence, a later pass decided the home
 * ownership it had already approved was an unresolved ambiguity. An unresolved
 * ambiguity is deliberately NOT repairable, so this costs no repair pass --
 * which is how the production ledger proves the reversal happened: every pass
 * after 12:22:32 shows exactly two model calls and no certificate.
 */
const REVERSED_VERDICT = Object.freeze({
  schemaVersion: 'ModuleInputVerificationV1',
  verdict: 'needs_clarification',
  unsupportedPaths: [],
  omittedSupportedInformation: [],
  unresolvedAmbiguities: ['Home ownership of the €500,000 property is not established by the conversation.'],
  clarifications: [
    {
      id: 'home-ownership',
      question: 'Is the €500,000 home jointly owned by you and your wife, or owned by just one of you?',
      relatedModuleIds: ['personal_balance_sheet'],
      relatedPaths: ['/assetPositions/1']
    }
  ],
  confirmationPromptApproved: false,
  explanation: 'The read-back calls the home jointly owned; the conversation says only "we have our house".'
});

let verifierReverses = false;

globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  const requestBody = JSON.parse(body.input?.[1]?.content || '{}');
  let value;
  if (body.text?.format?.name === 'module_planning_snapshot_v1') {
    extractionCalls += 1;
    const turns = requestBody.conversation || [];
    value = extractionFor(
      requestBody.throughTurnId,
      Number(requestBody.previousSnapshot?.snapshotRevision || 0),
      turns.find((turn) => turn.text === POSITION_TURN)?.turnId || requestBody.throughTurnId,
      turns.find((turn) => turn.text === SPEND_TURN)?.turnId || requestBody.throughTurnId
    );
  } else if (body.text?.format?.name === 'module_input_verification_v1') {
    verificationCalls += 1;
    value = verifierReverses ? REVERSED_VERDICT : PASS_VERDICT;
  } else if (body.text?.format?.name === APPROVAL_DECISION_SCHEMA_NAME) {
    approvalCalls += 1;
    approvalEnvelopes.push(requestBody);
    return approvalDecisionResponse(requestBody);
  } else {
    throw new Error(`Unexpected model request ${body.text?.format?.name || 'unknown'}`);
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

/* ------------------------------------------------------------- the checks */

// The utterance itself, before any machinery. This is what production stored.
//
// It used to be checked against a dictionary here, and "Ja." was added to that
// dictionary because of this call. The reading is now a judgement made in
// context by a bounded model, so what this asserts is the judgement -- that a
// competent reader, shown this reply to this read-back, calls it agreement to
// the offer and nothing else. The dictionary is gone; the obligation is not.
{
  const reading = scriptedApprovalDecision({ clientReply: APPROVAL });
  equal(reading.decision, 'pure_approval',
    'The approval Whisper produced for this client must read as agreement, not as an unclear answer.');
  equal(reading.answeredProposition, 'offer',
    'and as agreement to the plan that was read back, not to something else');
}
pass('the production approval utterance reads as agreement to the delivered offer');

const meeting = await newLiveMeeting('live-certified-approval', {
  CONSUMER_MODULE_PLANNER_MODE: 'apply',
  OPENAI_API_KEY: 'synthetic-test-key'
});
const { session, durable, provider } = await attachLiveSession(meeting);
const simulator = new LiveProviderSimulator({ session, durable, provider });

await simulator.turn({
  clientText: POSITION_TURN,
  act: async () => ({ speech: 'Thanks, that gives me a clear picture. Roughly how much does your household spend each month?' })
});
await settle(durable, session);

await simulator.turn({
  clientText: SPEND_TURN,
  act: async () => ({ speech: 'Okay, thanks. Let me line this up so we can move toward a clear snapshot.' })
});
await settle(durable, session);

let confirmationToken = null;
const readBack = await simulator.turn({
  clientText: SNAPSHOT_ONLY_TURN,
  act: async ({ callTool }) => {
    const state = await callTool('get_state', {});
    confirmationToken = state.result?.confirmationToken || null;
    equal(state.result?.confirmationPrompt, CONFIRMATION_PROMPT,
      'the certified prompt must reach the model verbatim');
    return { speech: state.result.confirmationPrompt };
  }
});
await settle(durable, session);

ok(confirmationToken, 'a ready plan must mint a confirmation token');
equal(session.directConfirmationOffer?.readbackFullyDelivered, true,
  'speaking the certified prompt verbatim must arm the offer');
const deliveredOffer = structuredClone(session.directConfirmationOffer);
equal(readBack.responseIds.length, 2, 'get_state must finish in its own continuation response');
pass('the certified plan is read back verbatim and the offer is armed');

// FROM HERE THE VERIFIER REVERSES ITSELF, exactly as production's did.
verifierReverses = true;
const extractionCallsBeforeApproval = extractionCalls;
const verificationCallsBeforeApproval = verificationCalls;

let confirmationResult = null;
await simulator.turn({
  clientText: APPROVAL,
  act: async ({ callTool, speak }) => {
    const call = await callTool('confirm_and_run', { confirmationToken });
    confirmationResult = call.result;
    await speak(call.result?.speakableText || 'That is running now.');
    return { alreadySpoken: true };
  }
});
await settle(durable, session);

equal(confirmationResult?.code, undefined,
  `the approved certified plan must not be refused (production returned ${JSON.stringify(confirmationResult?.code)})`);
equal(confirmationResult?.ok, true, 'the approved certified plan must execute');
equal(confirmationResult?.status, 'complete', 'execution must complete, not stall');
pass('the client’s approval of a delivered certified plan executes it');

equal(session.directConfirmationOffer?.planId, deliveredOffer.planId,
  'a background pass must not swap the plan the client approved');

// THE READER WAS ASKED, AND IT WAS ASKED THE RIGHT QUESTION. A decision made
// without the delivered offer, or without the utterance the client was
// answering, is not the architecture -- it is a coin toss with a schema.
equal(approvalCalls, 1, 'the approval turn must be read exactly once, not once per barrier');
{
  const envelope = approvalEnvelopes.at(-1);
  equal(envelope.clientReply, APPROVAL, 'the reader must see the complete client reply');
  equal(envelope.offer.deliveredConfirmationPrompt, CONFIRMATION_PROMPT,
    'the reader must see the exact certified offer as it was delivered');
  equal(envelope.offer.offerToken, deliveredOffer.token, 'bound to the delivered offer token');
  equal(envelope.answeredUtterance.isTheCertifiedOffer, true,
    'and must be told that this reply answered the read-back itself');
  equal(envelope.answeredUtterance.text, CONFIRMATION_PROMPT,
    'the utterance the client answered is the certified read-back, quoted in full');
  ok(envelope.turn.ordinal > 0, 'the decision is bound to a server-owned turn ordinal');
}
pass('the approval reader is given the offer, the answered utterance and the reply');

// NO SECOND OPINION ON AN UNCHANGED PLAN. The reversing verifier is still
// armed; a pure approval must not have invited it back in. Counted across the
// approval turn rather than absolutely, so this measures what the approval
// cost and not what the three turns before it cost.
equal(verificationCalls - verificationCallsBeforeApproval, 0,
  'a pure approval must not rerun the verifier over a plan the client already accepted');
equal(extractionCalls - extractionCallsBeforeApproval, 0,
  'and must not rerun the planner either');
pass('an approved plan is not reopened by the planner or the verifier');

const runs = (await meeting.env.CONSUMER_DB.prepare(`
  SELECT status FROM consumer_module_runs WHERE session_id = ? AND module_id = 'personal_balance_sheet'
`).bind(meeting.sessionId).all()).results || [];
equal(runs.length, 1, 'the approved plan must run exactly once');
equal(runs[0].status, 'complete', 'the balance sheet must complete');

const stage = (await meeting.env.CONSUMER_DB.prepare(
  'SELECT stage FROM consumer_sessions WHERE id = ?'
).bind(meeting.sessionId).first()).stage;
equal(stage, 'results', 'the client must reach results');
pass('the overall snapshot runs exactly once and the client reaches results');

/* ------------------------------------------------------------ scenario 2 */

/**
 * THE AMPLIFIER, ISOLATED FROM THE CLASSIFIER.
 *
 * Widening the approval vocabulary fixes this client. It does not fix the
 * defect underneath, because ANY unrecognised turn between the read-back and
 * the approval reaches the same place: production's own "Do I need to do it?"
 * would have done it too.
 *
 * A fresh verifier rejection must withdraw the offer, even if the extractor
 * repeats identical inputs. check-first20-verifier-rejection.mjs demonstrates
 * why the former expectation was unsafe: a client corrects 240,000 to 340,000,
 * the extractor misses it, and the verifier notices. Comparing the candidate
 * alone cannot distinguish that real correction from model variance.
 *
 * Keep the reversal scenario, assert safe refusal, and then prove the client
 * can clarify, receive a newly certified read-back, and complete exactly once.
 */
{
  verifierReverses = false;
  extractionCalls = 0;
  verificationCalls = 0;

  const meeting2 = await newLiveMeeting('live-certified-approval-continuity', {
    CONSUMER_MODULE_PLANNER_MODE: 'apply',
    OPENAI_API_KEY: 'synthetic-test-key'
  });
  const rig = await attachLiveSession(meeting2);
  const sim = new LiveProviderSimulator({ session: rig.session, durable: rig.durable, provider: rig.provider });

  await sim.turn({ clientText: POSITION_TURN, act: async () => ({ speech: 'Thanks. Roughly how much does your household spend each month?' }) });
  await settle(rig.durable, rig.session);
  await sim.turn({ clientText: SPEND_TURN, act: async () => ({ speech: 'Okay, let me line that up.' }) });
  await settle(rig.durable, rig.session);

  let token = null;
  await sim.turn({
    clientText: SNAPSHOT_ONLY_TURN,
    act: async ({ callTool }) => {
      const state = await callTool('get_state', {});
      token = state.result?.confirmationToken || null;
      return { speech: state.result.confirmationPrompt };
    }
  });
  await settle(rig.durable, rig.session);
  ok(token, 'the continuity scenario must reach a certified read-back');
  const delivered = structuredClone(rig.session.directConfirmationOffer);

  // From here the verifier reverses itself, exactly as production's did.
  verifierReverses = true;

  // The client's real next turn. It adds no financial content -- it asks
  // whether they have to do anything -- but it is not an approval, so it
  // schedules the pass that reverses.
  await sim.turn({
    clientText: 'Do I need to do it?',
    act: async () => ({ speech: 'Yes — just say the word and I will run it.' })
  });
  await settle(rig.durable, rig.session);

  equal(rig.session.directConfirmationOffer, null,
    'the latest verifier rejection must retire the delivered offer even with identical candidate inputs');
  pass('a verifier reversal retires the offer until the ambiguity is resolved');

  let secondResult = null;
  await sim.turn({
    clientText: 'Yes, go ahead.',
    act: async ({ callTool, speak }) => {
      const call = await callTool('confirm_and_run', { confirmationToken: token });
      secondResult = call.result;
      await speak(call.result?.speakableText || 'Running that now.');
      return { alreadySpoken: true };
    }
  });
  await settle(rig.durable, rig.session);

  equal(secondResult?.ok, false, 'an approval cannot override the latest verifier rejection');
  const rejectedRuns = (await meeting2.env.CONSUMER_DB.prepare(
    'SELECT COUNT(*) AS n FROM consumer_module_runs WHERE session_id = ?'
  ).bind(meeting2.sessionId).first()).n;
  equal(rejectedRuns, 0, 'a rejected review must run no module');

  verifierReverses = false;
  await sim.turn({
    clientText: 'The home is jointly owned by me and my wife. Please check and read the plan back again.',
    act: async ({ callTool }) => {
      const state = await callTool('get_state', {});
      token = state.result?.confirmationToken || null;
      return { speech: state.result.confirmationPrompt };
    }
  });
  await settle(rig.durable, rig.session);
  ok(token && token !== delivered.token, 'clarification must issue a fresh certified offer');
  equal(rig.session.directConfirmationOffer?.readbackFullyDelivered, true,
    'the newly certified plan must be delivered before approval');
  await sim.turn({
    clientText: 'Yes, go ahead.',
    act: async ({ callTool }) => {
      secondResult = (await callTool('confirm_and_run', { confirmationToken: token })).result;
      return {};
    }
  });
  await settle(rig.durable, rig.session);
  equal(secondResult?.ok, true, 'a clarified and newly certified plan must execute on approval');
  const runs2 = (await meeting2.env.CONSUMER_DB.prepare(
    'SELECT COUNT(*) AS n FROM consumer_module_runs WHERE session_id = ?'
  ).bind(meeting2.sessionId).first()).n;
  equal(runs2, 1, 'exactly one run');
  pass('the client can clarify after a rejected review, approve the fresh read-back, and run exactly once');
}

console.info(`[CertifiedApproval] ${checks} checks passed.`);
