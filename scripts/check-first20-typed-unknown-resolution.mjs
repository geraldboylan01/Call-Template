#!/usr/bin/env node
// Real typed ingest, planner boundary, encrypted briefs, signed certificates,
// durable acknowledgement storage and engine. Only model responses are scripted.
import assert from 'node:assert/strict';
import { attachTypedSession, newLiveMeeting, settle } from './live-harness/session.mjs';
import { directModuleTestInputs } from './live-harness/direct-fixtures.mjs';
import { getLatestRealtimeMeetingBrief } from '../worker/src/consumer/realtime_repository.js';

const INPUT = directModuleTestInputs(new Date().toISOString().slice(0, 10)).mortgage_analysis;
const DETAILS = 'Please analyse my repayment mortgage. The balance is €240,000, there are 22 years remaining and I want no overpayments.';
const ANSWER = 'I checked my mortgage statement: the current annual interest rate is 4.1%.';
const PROMPT = 'I will analyse your repayment mortgage using a €240,000 balance, 4.1% annual interest and 22 years remaining, with no overpayments. Shall I run that plan?';
let verdict = 'needs_clarification';
let rendererSteps = [];
let calls = 0;
const originalFetch = globalThis.fetch;
const payload = (value) => ({ ok: true, json: async () => ({ status: 'completed', output_text: JSON.stringify(value), usage: {} }) });
globalThis.fetch = async (_url, request) => {
  const body = JSON.parse(request.body);
  const schema = body.text?.format?.name;
  if (!schema) {
    const step = rendererSteps.shift();
    assert.ok(step, 'a typed renderer step must have been scripted');
    const output = step.tool
      ? [{ type: 'function_call', name: step.tool, arguments: JSON.stringify(step.args || {}), call_id: `unknown_resolution_${++calls}` }]
      : [{ type: 'message', content: [{ type: 'output_text', text: step.text }] }];
    return { ok: true, json: async () => ({ status: 'completed', output, usage: {} }) };
  }
  const envelope = JSON.parse(body.input[1].content);
  if (schema === 'module_planning_snapshot_v1') {
    const source = envelope.conversation.find((turn) => turn.text === DETAILS);
    const answer = envelope.conversation.find((turn) => turn.text === ANSWER);
    assert.ok(source);
    const input = { ...INPUT };
    if (!answer) delete input.annualInterestRate;
    return payload({
      schemaVersion: 'ModulePlanningSnapshotV1',
      baseSnapshotRevision: Number(envelope.previousSnapshot?.snapshotRevision || 0),
      throughTurnId: envelope.throughTurnId,
      generalAmbiguities: [], confirmationPrompt: answer ? PROMPT : '',
      modules: [{
        moduleId: 'mortgage_analysis', outputKey: 'generated.mortgageInputs',
        status: answer ? 'ready' : 'collecting',
        selection: { origin: 'client_requested', reason: 'You asked to analyse the existing mortgage.' },
        inputJson: JSON.stringify(input), steeringSummary: 'An existing repayment mortgage with €240,000 remaining over 22 years.',
        missing: answer ? [] : [{ path: '/annualInterestRate', question: 'What is the annual mortgage interest rate?', reason: 'The repayment calculation needs the current rate.' }],
        ambiguities: [],
        assumptions: [
          { path: '/endDateIso', valueJson: 'null', source: 'contract_default' },
          { path: '/fixedPaymentAmount', valueJson: 'null', source: 'contract_default' },
          { path: '/oneOffOverpayment', valueJson: '0', source: 'contract_default' },
          { path: '/annualOverpayment', valueJson: '0', source: 'contract_default' }
        ],
        evidence: [
          { path: '/currentBalance', source: 'conversation', turnId: source.turnId, quote: '€240,000', profilePath: '' },
          { path: '/remainingTermYears', source: 'conversation', turnId: source.turnId, quote: '22 years', profilePath: '' },
          ...(answer ? [{ path: '/annualInterestRate', source: 'conversation', turnId: answer.turnId, quote: ANSWER, profilePath: '' }] : [])
        ],
        resolvedAcknowledgedUnknown: answer ? [{ path: '/annualInterestRate', turnId: answer.turnId, quote: ANSWER }] : []
      }]
    });
  }
  assert.equal(schema, 'module_input_verification_v1');
  return payload({
    schemaVersion: 'ModuleInputVerificationV1', verdict,
    unsupportedPaths: [], omittedSupportedInformation: [],
    unresolvedAmbiguities: verdict === 'pass' ? [] : ['The later answer still needs clarification.'],
    clarifications: verdict === 'pass' ? [] : [{ id: 'rate-review', question: 'Please clarify the current rate.', relatedModuleIds: ['mortgage_analysis'], relatedPaths: ['/annualInterestRate'] }], confirmationPromptApproved: verdict === 'pass',
    explanation: verdict === 'pass' ? 'The later client answer resolves the acknowledged unknown.' : 'Synthetic verifier rejection: do not clear the acknowledgement.'
  });
};

let checks = 0;
function equal(actual, expected, message) { checks += 1; assert.deepEqual(actual, expected, message); }
try {
  const meeting = await newLiveMeeting('first20-typed-unknown-resolution', {
    CONSUMER_MODULE_PLANNER_MODE: 'apply', CONSUMER_TYPED_LANE_ENABLED: 'true', OPENAI_API_KEY: 'synthetic-test-key'
  });
  let rig = await attachTypedSession(meeting);
  async function turn(text, extra = {}, tool = null) {
    rendererSteps = [...(tool ? [tool] : []), { text: 'Thanks, I have recorded that.' }];
    const reply = await rig.session.handleTextMessage({ text, ...extra });
    await settle(rig.durable, rig.session);
    equal(rendererSteps.length, 0, 'the actual typed renderer consumed every scripted action');
    return reply;
  }
  const collecting = await turn(DETAILS);
  const field = collecting.card.modules[0].fields[0];
  equal(field.question, 'What is the annual mortgage interest rate?', 'the question has a real opaque card binding');
  await turn('I do not know my mortgage interest rate.', { unknownFieldId: field.unknownFieldId });
  equal(rig.session.acknowledgedUnknown.length, 1, 'the unknown is persisted');
  const acknowledged = structuredClone(rig.session.acknowledgedUnknown);
  equal(typeof acknowledged[0].sourceTurnId, 'string', 'the acknowledgement is bound to its durable client turn');
  await rig.durable.state.storage.put('lease', rig.session.meta);
  rig = await attachTypedSession(meeting, { initial: Object.fromEntries(rig.durable.values) });
  equal(rig.session.acknowledgedUnknown, acknowledged, 'the exact acknowledgement survives eviction');

  await turn(ANSWER);
  equal(rig.session.acknowledgedUnknown, acknowledged, 'a candidate resolution rejected by the verifier cannot erase the unknown');
  equal(rig.durable.values.get('acknowledgedUnknown'), acknowledged, 'rejection preserves the durable acknowledgement too');
  let brief = (await getLatestRealtimeMeetingBrief(meeting.env, meeting.sessionId, meeting.meetingId)).brief;
  equal(brief.verificationCertificate, null, 'the rejected answer has no execution certificate');

  verdict = 'pass';
  const presented = await turn('Please check that statement rate and read the plan back.', {}, { tool: 'get_state' });
  brief = (await getLatestRealtimeMeetingBrief(meeting.env, meeting.sessionId, meeting.meetingId)).brief;
  equal(Boolean(brief.verificationCertificate?.signature), true, 'the recovered plan is independently certified');
  equal(rig.session.acknowledgedUnknown, [], 'only the certified later answer clears the acknowledgement');
  equal(rig.durable.values.get('acknowledgedUnknown'), [], 'certified clearance is durable');
  equal(presented.assistantText, PROMPT, 'the exact certified recovered plan is displayed');
  await turn('Yes, go ahead.', {}, { tool: 'confirm_and_run', args: { confirmationToken: rig.session.directConfirmationOffer.token } });
  equal(rig.session.directConfirmationOffer.executionStatus, 'complete', 'the recovered typed plan executes on one approval');
  const count = await meeting.env.CONSUMER_DB.prepare('SELECT COUNT(*) AS n FROM consumer_module_runs WHERE session_id = ?').bind(meeting.sessionId).first();
  equal(count.n, 1, 'recovery produces exactly one real engine result');
  console.info(`[First20TypedUnknownResolution] ${checks} checks passed.`);
} finally {
  globalThis.fetch = originalFetch;
}
