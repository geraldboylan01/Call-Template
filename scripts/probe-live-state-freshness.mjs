#!/usr/bin/env node

/**
 * Paid real-model probe: is the state Realtime steers on fresh enough?
 *
 * THE WORRY THIS ANSWERS. Background planning trails the conversation, so a
 * client who answers three questions in one breath could be asked one of them
 * again purely because the planner had not published yet. This runs the real
 * live Durable Object, the real transcript storage and the real background
 * planner -- nothing about the planner is scripted -- and reads exactly what
 * get_state hands the model after a dense answer.
 *
 * Two shapes are exercised:
 *   settled  - the transcript finalized before Realtime asked for state
 *   delayed  - Realtime asked for state while ASR was still running (the
 *              production race: the tool call arrives before the transcript)
 */

import { attachLiveSession, newLiveMeeting, settle } from './live-harness/session.mjs';
import { LiveProviderSimulator } from './live-harness/provider.mjs';

if (!String(process.env.OPENAI_API_KEY || '').trim()) {
  console.error('OPENAI_API_KEY is required for this paid probe.');
  process.exit(2);
}

const GOAL = 'I want to know if my pension is on track. I am hoping to retire at sixty.';
// Three separate facts in one breath, one of them a spoken quantity.
const DENSE = 'I am forty two, the pot is about three hundred and ten thousand, and I put in two and a half thousand a month.';

const meeting = await newLiveMeeting('live-state-freshness', {
  CONSUMER_MODULE_PLANNER_MODE: 'apply',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY
});
const rig = await attachLiveSession(meeting);
const simulator = new LiveProviderSimulator(rig);

function report(label, state) {
  const modules = state?.modules || [];
  console.log(`\n--- ${label}`);
  console.log('  snapshotRevision:', state?.snapshotRevision);
  console.log('  modules         :', modules.map((m) => `${m.moduleId}=${m.status}`).join(', ') || '(none)');
  for (const m of modules) {
    console.log(`  knownSummary[${m.moduleId}]:`, m.knownSummary);
    console.log(`  missing[${m.moduleId}]     :`, JSON.stringify((m.missing || []).map((x) => x.path || x.question || x)));
  }
  const summary = modules.map((m) => m.knownSummary || '').join(' ');
  const facts = {
    age42: /\b42\b|forty[- ]?two/i.test(summary),
    pot310k: /310,?000|three hundred and ten/i.test(summary),
    contrib2500: /2,?500|two and a half thousand/i.test(summary),
    retire60: /\b60\b|sixty/i.test(summary)
  };
  console.log('  facts visible to Realtime:', JSON.stringify(facts));
  return facts;
}

// Turn 1: the goal. Realtime speaks; planning starts in the background.
await simulator.turn({ clientText: GOAL, act: async () => ({ speech: 'Happy to look at that with you.' }) });
await settle(rig.durable, rig.session);

// Turn 2 (SETTLED): the dense answer, transcript already final, then get_state.
let settledState = null;
await simulator.turn({
  clientText: DENSE,
  act: async ({ callTool }) => {
    settledState = (await callTool('get_state', {})).result;
    return { speech: 'Thanks, that is helpful.' };
  }
});
const settledFacts = report('SETTLED: state read after a dense answer', settledState);
await settle(rig.durable, rig.session);

// Turn 3 (DELAYED ASR): Realtime asks for state while the transcript is still
// in flight -- the production race. The tool must not be answered from state
// that predates the sentence which caused it.
const itemId = `item_${++simulator.itemSeq}`;
await simulator.send({ type: 'input_audio_buffer.speech_stopped', item_id: itemId });
const response = await simulator.startResponse(null);
const before = rig.provider.sent.length;
await simulator.send({
  type: 'response.function_call_arguments.done',
  response_id: response.responseId,
  call_id: 'call_delayed',
  name: 'get_state',
  arguments: '{}'
});
const answeredEarly = rig.provider.sent.slice(before)
  .some((e) => e?.item?.type === 'function_call_output');
console.log('\n  answered before the transcript landed?', answeredEarly);
await simulator.send({
  type: 'conversation.item.input_audio_transcription.completed',
  item_id: itemId,
  transcript: 'Sorry, one more thing - my salary is seventy grand.'
});
await settle(rig.durable, rig.session);
const out = rig.provider.sent
  .find((e) => e?.item?.type === 'function_call_output' && e.item.call_id === 'call_delayed');
const delayedState = out ? JSON.parse(out.item.output) : null;
const delayedFacts = report('DELAYED ASR: state read while the transcript was still arriving', delayedState);
const salarySeen = /70,?000|seventy/i.test((delayedState?.modules || []).map((m) => m.knownSummary || '').join(' '));
console.log('  salary from the in-flight turn visible:', salarySeen);

console.log('\nRESULT');
console.log('  settled read shows every fact from the dense answer:',
  Object.values(settledFacts).every(Boolean));
console.log('  delayed read was NOT answered early:', !answeredEarly);
console.log('  delayed read includes the in-flight turn:', salarySeen);
if (!Object.values(settledFacts).every(Boolean) || answeredEarly || !salarySeen) {
  process.exitCode = 1;
}
