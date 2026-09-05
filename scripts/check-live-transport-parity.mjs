#!/usr/bin/env node

/**
 * ONE PLANNING ENGINE, TWO TRANSPORTS -- ASSERTED, NOT ASSUMED.
 *
 * The governing principle of the parity contract is that only audio capture,
 * speech generation, interruption handling and provider mechanics may differ
 * between transports. This file is what makes that claim checkable for the
 * consumer typed lane (D-08).
 *
 * It drives the SAME utterances through a spoken meeting and a typed one, over
 * a real Durable Object on a real migrated database, with the planner's opinion
 * scripted identically for both. It then compares the planning state each
 * produced -- which modules are in play, their readiness, what each still
 * needs, whose idea each was, and whether the plan may be confirmed.
 *
 * WORDING IS NOT COMPARED AND NEVER WILL BE. Voice speaks through the Realtime
 * model, text renders through Responses, and the two will not agree on a
 * sentence. Parity is asserted on planning state, never on prose.
 *
 * WHAT WOULD FAIL THIS. A typed lane that skipped the planner, applied a
 * different module allowlist, wrote turns the planner could not quote, or
 * reached readiness by a different route. All four are the ways a second
 * planning architecture starts.
 */

import assert from 'node:assert/strict';

import { LiveProviderSimulator } from './live-harness/provider.mjs';
import { attachLiveSession, attachTypedSession, newLiveMeeting, settle } from './live-harness/session.mjs';
import { directModuleTestInputs } from './live-harness/direct-fixtures.mjs';
import { getLatestRealtimeMeetingBrief, listRealtimeFinalTurns } from '../worker/src/consumer/realtime_repository.js';

let checks = 0;
function equal(actual, expected, message) { checks += 1; assert.deepEqual(actual, expected, message); }
function ok(value, message) { checks += 1; assert.ok(value, message); }

/** The conversation both transports are given, word for word. */
const UTTERANCES = [
  'I have a mortgage of about 240,000 left and I want to know if overpaying is worth it.',
  'The rate is 4.1% and there are 22 years to run.'
];

/**
 * The planner's opinion, scripted once and shared.
 *
 * It is a function of the TRANSCRIPT, not a constant, so parity means the two
 * transports handed the planner the same conversation -- not merely that a
 * fixed answer was stored twice.
 */
// The real native input, so the snapshot passes the SAME policy and provenance
// assertions production applies. A shape invented for the test would be refused
// by the normaliser, and the parity comparison would be of two empty briefs.
const MORTGAGE_INPUT = directModuleTestInputs(new Date().toISOString().slice(0, 10)).mortgage_analysis;

function plannerSnapshotFor(conversation, throughTurnId, baseRevision) {
  const heard = conversation.map((turn) => String(turn?.text || '')).join(' ');
  const knowsRate = /4\.1%/.test(heard);
  return {
    schemaVersion: 'ModulePlanningSnapshotV1',
    baseSnapshotRevision: baseRevision,
    throughTurnId,
    generalAmbiguities: [],
    confirmationPrompt: '',
    modules: [{
      moduleId: 'mortgage_analysis',
      outputKey: 'generated.mortgageInputs',
      status: 'collecting',
      selection: { origin: 'client_requested', reason: 'they asked whether overpaying is worth it' },
      inputJson: JSON.stringify(MORTGAGE_INPUT),
      steeringSummary: 'A mortgage of about 240,000.',
      missing: knowsRate
        ? [{ path: '/annualOverpayment', reason: 'the comparison needs an overpayment', question: 'How much extra could you pay?' }]
        : [
          { path: '/annualInterestRate', reason: 'the comparison needs a rate', question: 'What rate are you on?' },
          { path: '/remainingTermYears', reason: 'the comparison needs a term', question: 'How many years are left?' }
        ],
      ambiguities: [],
      assumptions: [],
      evidence: []
    }]
  };
}

/** Own fetch for the whole run: the planner's opinion and the renderer's words. */
function scriptModels(replies) {
  const original = globalThis.fetch;
  let index = 0;
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('api.openai.com')) return original(url, init);
    const body = JSON.parse(init?.body || '{}');
    const schemaName = body?.text?.format?.name || '';

    if (schemaName === 'module_input_verification_v1') {
      return jsonResponse({
        schemaVersion: 'ModuleInputVerificationV1',
        verdict: 'needs_clarification',
        unsupportedPaths: [], omittedSupportedInformation: [], unresolvedAmbiguities: [],
        clarifications: [], confirmationPromptApproved: false, explanation: 'still collecting'
      });
    }
    if (schemaName === 'module_planning_snapshot_v1') {
      // The envelope is the USER message; the system message is the prompt.
      const envelope = safeJson(body?.input?.find((item) => item?.role === 'user')?.content) || {};
      const conversation = Array.isArray(envelope.conversation) ? envelope.conversation : [];
      const throughTurnId = String(envelope.throughTurnId || conversation.at(-1)?.turnId || '');
      // Read from the envelope rather than counted here: the normaliser refuses
      // a snapshot whose base does not match the state it was built on, and
      // guessing would make the test's own bookkeeping the thing under test.
      const baseRevision = Number(envelope.previousSnapshot?.snapshotRevision || 0);
      return jsonResponse(plannerSnapshotFor(conversation, throughTurnId, baseRevision));
    }
    // Anything else the lane calls out for -- the compliance review, the
    // supervisor -- is answered blandly. Scripting it would be scripting a
    // judgement neither transport's parity depends on.
    if (schemaName) return jsonResponse({ ok: true });
    // The typed renderer. Voice never reaches here: it speaks through the
    // provider socket, which is exactly the difference parity permits.
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return new Response(JSON.stringify({
      output: [{ type: 'message', content: [{ type: 'output_text', text: reply }] }],
      usage: { input_tokens: 50, output_tokens: 10 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { restore() { globalThis.fetch = original; } };
}

/**
 * A Responses payload the production reader will accept.
 *
 * `status: 'completed'` matters: the planner refuses an incomplete response
 * outright, which is correct -- a truncated snapshot is worse than none.
 */
function jsonResponse(payload) {
  return new Response(JSON.stringify({
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(payload) }] }],
    usage: { input_tokens: 100, output_tokens: 50 }
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function safeJson(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '')); } catch (_error) { return null; }
}

const ENV = {
  CONSUMER_MODULE_PLANNER_MODE: 'apply',
  CONSUMER_TYPED_LANE_ENABLED: 'true',
  OPENAI_API_KEY: 'synthetic-test-key'
};

/** The planning state a meeting reached, stripped of everything transport-owned. */
async function planningStateOf(meeting) {
  const record = await getLatestRealtimeMeetingBrief(meeting.env, meeting.sessionId, meeting.meetingId);
  const brief = record?.brief;
  if (!brief) return null;
  return {
    readyToConfirm: brief.readyToConfirm === true,
    provisional: brief.provisional === true,
    modules: (brief.modules || []).map((module) => ({
      moduleId: module.moduleId,
      status: module.status,
      missing: (module.missing || []).map((need) => need.path).sort(),
      blocked: (module.blocked || []).map((entry) => entry.path).sort()
    })).sort((left, right) => left.moduleId.localeCompare(right.moduleId)),
    origins: (brief.directModuleSnapshot?.modules || [])
      .filter((module) => module.status !== 'not_relevant')
      .map((module) => `${module.moduleId}:${module.selection?.origin}`)
      .sort()
  };
}

/* ------------------------------------------------------------------ spoken */

const spokenMeeting = await newLiveMeeting('parity-spoken', ENV);
const spokenRig = await attachLiveSession(spokenMeeting);
let models = scriptModels(['…']);
const provider = new LiveProviderSimulator(spokenRig);
for (const clientText of UTTERANCES) {
  await provider.turn({ clientText, act: async ({ speak }) => { await speak('Thanks — noted.'); } });
  await settle(spokenRig.durable, spokenRig.session);
}
models.restore();
const spokenState = await planningStateOf(spokenMeeting);
const spokenTurns = (await listRealtimeFinalTurns(spokenMeeting.env, spokenMeeting.sessionId, spokenMeeting.meetingId))
  .filter((turn) => turn.role === 'user').map((turn) => turn.transcript);

/* ------------------------------------------------------------------- typed */

const typedMeeting = await newLiveMeeting('parity-typed', ENV);
const typedRig = await attachTypedSession(typedMeeting);
models = scriptModels(['Thanks — noted.', 'Thanks — noted.']);
for (const clientText of UTTERANCES) {
  await typedRig.session.handleTextMessage({ text: clientText });
  await settle(typedRig.durable, typedRig.session);
}
models.restore();
const typedState = await planningStateOf(typedMeeting);
const typedTurns = (await listRealtimeFinalTurns(typedMeeting.env, typedMeeting.sessionId, typedMeeting.meetingId))
  .filter((turn) => turn.role === 'user').map((turn) => turn.transcript);

/* ------------------------------------------------------------------ verdict */

ok(spokenState, 'the spoken meeting produced planning state');
ok(typedState, 'the typed meeting produced planning state');

// THE CLIENT SAID THE SAME THING, AND BOTH TRANSPORTS RECORDED IT THE SAME WAY.
// A planner quote must resolve against a stored turn, so a transport that
// reshaped the transcript would silently break evidence for every value in it.
equal(typedTurns, UTTERANCES, 'the typed lane stores the client\'s exact words');
equal(spokenTurns, typedTurns, 'both transports store the same client transcript');

// AND THE ENGINE REACHED THE SAME CONCLUSION FROM IT.
equal(typedState.modules, spokenState.modules,
  'identical modules, readiness and outstanding requirements across transports');
equal(typedState.origins, spokenState.origins,
  'identical attribution: whose idea each analysis was does not depend on the transport');
equal(typedState.readyToConfirm, spokenState.readyToConfirm,
  'both reach the same confirmation readiness');
equal(typedState.provisional, spokenState.provisional,
  'both agree on whether the plan is still provisional');

// The planner was genuinely exercised, not skipped on either side.
ok(spokenState.modules.length > 0, 'the spoken meeting selected an analysis');
equal(spokenState.modules[0].moduleId, 'mortgage_analysis', 'the analysis the client asked for');

console.log(`[LiveTransportParity] ${checks} checks passed across ${UTTERANCES.length} mirrored turns.`);
