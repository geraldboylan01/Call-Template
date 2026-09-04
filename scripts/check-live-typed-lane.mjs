#!/usr/bin/env node

/**
 * THE TYPED LANE IS THE SAME MEETING WITH A DIFFERENT MOUTH.
 *
 * Everything asserted here is about that claim, and every assertion is written
 * so that the cheap way of building a typed lane -- a second prompt, a second
 * planner, a second fact writer -- fails it.
 *
 * WHAT IS REAL: the Durable Object, D1, encryption, the catalogue prompt, the
 * toolset, the direct-module planner's normaliser and certificate, the whole
 * confirmation barrier. WHAT IS SCRIPTED: the two model opinions -- what the
 * planner concluded and what the renderer said -- because those are the only
 * two things a test cannot own.
 */

import assert from 'node:assert/strict';

import { attachTypedSession, newLiveMeeting, settle } from './live-harness/session.mjs';
import { buildLiveCataloguePrompt, LIVE_PROMPT_VERSION } from '../worker/src/consumer/live/catalogue_prompt.js';
import { liveToolsForConfig } from '../worker/src/consumer/live/live_provider.js';
import { listRealtimeFinalTurns } from '../worker/src/consumer/realtime_repository.js';

let checks = 0;
function ok(value, message) { checks += 1; assert.ok(value, message); }
function equal(actual, expected, message) { checks += 1; assert.equal(actual, expected, message); }

/* ------------------------------------------------------------------ prompt */

// ONE PROMPT PACK, NOT TWO. The delivery shape may differ. Everything that
// decides what Planéir does -- the analyses, the fact definitions, the safety
// rules, the Ireland rules, the conversation stages -- may not. If a future
// edit adds a typed-only rule about WHAT to collect, these fail.
const voicePrompt = buildLiveCataloguePrompt({ directModulePlanning: true, channel: 'voice' });
const textPrompt = buildLiveCataloguePrompt({ directModulePlanning: true, channel: 'text' });
ok(voicePrompt !== textPrompt, 'the two channels must not be byte-identical');

const SHARED_SECTIONS = [
  '## CONVERSATION FLOW',
  '## STAYING USEFUL',
  '## SAFETY',
  '## IRELAND',
  '## THE ANALYSES YOU CAN OFFER'
];
function sectionOf(prompt, heading) {
  const start = prompt.indexOf(heading);
  if (start < 0) return null;
  const next = prompt.indexOf('\n## ', start + heading.length);
  return prompt.slice(start, next < 0 ? prompt.length : next);
}
let shared = 0;
for (const heading of SHARED_SECTIONS) {
  const a = sectionOf(voicePrompt, heading);
  if (a === null) continue;
  shared += 1;
  equal(sectionOf(textPrompt, heading), a, `${heading} must be byte-identical across channels`);
}
ok(shared >= 3, `expected to compare several shared sections, compared ${shared}`);

// The typed prompt must not be telling the model it is speaking.
for (const forbidden of [/having a spoken conversation/, /Speak confirmationPrompt verbatim/, /say(?:ing)? .{0,12}aloud/]) {
  ok(!forbidden.test(textPrompt), `typed prompt must not instruct speech: ${forbidden}`);
}
ok(/having a typed conversation/.test(textPrompt), 'typed prompt states its channel');
// THE READ-BACK IS THE SERVER'S. If this ever flips, the typed lane has
// silently handed the certified wording back to a model.
ok(/DO NOT compose a read-back of your own/.test(textPrompt),
  'typed prompt forbids the model composing its own read-back');
ok(/Speak confirmationPrompt verbatim/.test(voicePrompt),
  'voice prompt still requires the spoken verbatim read-back');

/* ------------------------------------------------------------------- tools */

// One toolset. A typed-only tool would mean a typed-only capability.
const cfg = { modulePlannerMode: 'apply' };
const tools = liveToolsForConfig(cfg).map((tool) => tool.name).sort();
assert.deepEqual(tools, ['confirm_and_run', 'get_state'], 'typed and voice share one toolset');
checks += 1;

/* -------------------------------------------------------------------- rig */

/**
 * Script the renderer's Responses call, and nothing else.
 *
 * The background planner shares this endpoint, and is told apart by the
 * structured-output schema it asks for -- the request's own statement of what
 * it is. Its opinion is deliberately NOT scripted here: this file is about the
 * transport, and a planner that returns nothing is the honest way to prove the
 * typed lane still replies when the background pass produces nothing.
 */
function scriptedRenderer(replies) {
  const original = globalThis.fetch;
  const seen = [];
  const order = [];
  let index = 0;
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('api.openai.com')) return original(url, init);
    const body = JSON.parse(init?.body || '{}');
    if (body?.text?.format || !Array.isArray(body?.tools)) {
      order.push('planner');
      return new Response(JSON.stringify({ output: [], usage: {} }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }
    order.push('renderer');
    seen.push(body);
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    const output = typeof reply === 'string'
      ? [{ type: 'message', content: [{ type: 'output_text', text: reply }] }]
      : [{ type: 'function_call', name: reply.tool, arguments: JSON.stringify(reply.args || {}), call_id: `call_${index}` }];
    return new Response(JSON.stringify({
      output, usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 10 } }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { seen, order, restore() { globalThis.fetch = original; } };
}

const meeting = await newLiveMeeting('typed-lane', {
  CONSUMER_MODULE_PLANNER_MODE: 'apply',
  CONSUMER_TYPED_LANE_ENABLED: 'true',
  // The renderer refuses to call out without one. Nothing reaches a real
  // provider: `scriptedRenderer` owns fetch for the duration.
  OPENAI_API_KEY: 'synthetic-test-key'
});
const { session, durable } = await attachTypedSession(meeting);

/* ------------------------------------------------------ one typed turn */

let renderer = scriptedRenderer(['That makes sense. What would you like to look at first?']);
const first = await session.handleTextMessage({ text: 'I am 43 and I want to retire at 60.' });
await settle(durable, session);
renderer.restore();

equal(first.ok, true, 'a typed turn succeeds');
ok(first.assistantText.length > 0, 'a typed turn produces a reply');
equal(first.readback, false, 'no plan is certified yet, so nothing is read back');
equal(first.fallback, false, 'the scripted renderer produced the reply, not the fallback');

// THE TYPED LANE AWAITS THE PLANNER, AND THIS IS THE ASSERTION THAT SAYS SO.
//
// It is the single behavioural difference that makes the screen trustworthy:
// the reply and the card are both built from a snapshot that has already read
// the message being answered. Reverting to voice's fire-and-forget scheduling
// would leave the planner call after the renderer call, or absent entirely,
// and this fails.
const plannerIndex = renderer.order.indexOf('planner');
const rendererIndex = renderer.order.indexOf('renderer');
ok(plannerIndex >= 0, 'a typed turn runs the background planner');
ok(plannerIndex < rendererIndex,
  `the planner must complete before the reply is rendered (order: ${renderer.order.join(' -> ')})`);

// THE INSTRUCTIONS THE RENDERER WAS ACTUALLY GIVEN. Asserting on the wire is
// the only way to catch a future edit that assembles its own prompt.
const rendererCall = renderer.seen.at(-1);
equal(rendererCall.instructions, textPrompt, 'the renderer is given the shared typed prompt verbatim');
equal(rendererCall.store, false, 'typed renders are never stored by the provider');
assert.deepEqual(rendererCall.tools.map((t) => t.name).sort(), tools, 'the renderer is given the shared toolset');
checks += 1;

/* ------------------------------------------- the turn is real evidence */

const turns = await listRealtimeFinalTurns(meeting.env, meeting.sessionId, meeting.meetingId);
const clientTurns = turns.filter((turn) => turn.role === 'user');
const assistantTurns = turns.filter((turn) => turn.role === 'assistant');
equal(clientTurns.length, 1, 'the typed message is persisted as one client turn');
equal(clientTurns[0].transcript, 'I am 43 and I want to retire at 60.',
  'the client turn carries their exact words, so a planner quote can resolve against it');
equal(assistantTurns.length, 1, 'the reply is persisted as one assistant turn');
equal(assistantTurns[0].transcript, first.assistantText, 'what was returned is what was stored');

// REPLY BINDING is what replaces the audio playback acknowledgement, so the
// link a typed answer carries has to exist from the very first turn.
ok('answers_turn_id' in clientTurns[0] || clientTurns[0].answersTurnId !== undefined,
  'a client turn records which assistant turn it answers');

/* ------------------------------------------------ a card is the same turn */

renderer = scriptedRenderer(['Thanks — that gives me what I need on the pension.']);
const carded = await session.handleTextMessage({
  text: 'Pension contribution: 6% of salary.\nRetirement age: 65.',
  inputMode: 'form'
});
await settle(durable, session);
renderer.restore();
equal(carded.ok, true, 'a card submission is an ordinary typed turn');

const afterCard = await listRealtimeFinalTurns(meeting.env, meeting.sessionId, meeting.meetingId);
const formTurn = afterCard.filter((turn) => turn.role === 'user').at(-1);
ok(/6% of salary/.test(formTurn.transcript),
  'a card submission reaches the transcript as the client\'s own words, quotable as evidence');

// THE ONE THING A CARD MUST NOT DO: write facts by a second route. If a card
// ever bypasses the turn pipeline, the transcript stops being the record of
// what the client said and two versions of their finances become possible.
equal(afterCard.filter((turn) => turn.role === 'user').length, 2,
  'a card submission is exactly one client turn, never a batch of writes');

/* --------------------------------------------------- no provider traffic */

// A typed meeting must never try to talk to a socket it does not have.
ok(session.textChannel === true, 'the session knows it is typed');
equal(session.webSocket, null, 'a typed meeting holds no provider socket');
session.sendProvider({ type: 'response.create' });
checks += 1;

console.log(`[LiveTypedLane] ${checks} checks passed (prompt ${LIVE_PROMPT_VERSION}).`);
