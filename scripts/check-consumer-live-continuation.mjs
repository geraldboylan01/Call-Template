/**
 * Live protocol: opening and function-call continuation.
 *
 * These checks deliberately exercise the Worker-side response ledger rather
 * than a scripted provider. A Realtime response terminates at its function
 * call; only response.create can begin the response that consumes the result.
 */

import assert from 'node:assert/strict';

import { buildLiveCataloguePrompt } from '../worker/src/consumer/live/catalogue_prompt.js';
import { ConsumerLiveSession } from '../worker/src/consumer/live/live_session.js';

function fakeDurableState(initial = {}) {
  const values = new Map(Object.entries(initial));
  const waitUntilPromises = [];
  let initialization;
  const state = {
    storage: {
      async get(key) { return values.get(key); },
      async put(key, value) { values.set(key, structuredClone(value)); },
      async delete(key) { values.delete(key); }
    },
    blockConcurrencyWhile(callback) { initialization = Promise.resolve(callback()); },
    waitUntil(promise) { waitUntilPromises.push(Promise.resolve(promise)); }
  };
  return { state, values, waitUntilPromises, initialized: () => initialization };
}

async function testSession(initial = {}) {
  const durable = fakeDurableState(initial);
  const session = new ConsumerLiveSession(durable.state, {
    CONSUMER_PLANNER_RECONCILIATION_MODE: 'shadow'
  });
  await durable.initialized();
  session.meta = {
    sessionId: 'cs_livecontinuation000000001',
    leaseId: 'rt_livecontinuation000000001',
    costEntryId: 'cost_livecontinuation000001'
  };
  session.handleUsage = async () => {};
  const sent = [];
  session.sendProvider = (event) => sent.push(structuredClone(event));
  return { session, durable, sent };
}

function responseCreates(sent) {
  return sent.filter((event) => event.type === 'response.create');
}

function assertStringMetadata(metadata) {
  for (const [key, value] of Object.entries(metadata || {})) {
    assert.equal(typeof value, 'string', `response.metadata.${key} must be a string`);
  }
}

/* -------------------------------------------- one at-most-once opening turn */

{
  const { session, durable, sent } = await testSession();
  assert.equal(await session.requestOpeningResponse(), true);
  assert.equal(await session.requestOpeningResponse(), false);
  assert.equal(responseCreates(sent).length, 1, 'activation may request exactly one opening');
  assert.deepEqual(responseCreates(sent)[0], {
    type: 'response.create',
    response: {
      tool_choice: 'none',
      metadata: { kind: 'opening', continuation_index: '0' }
    }
  });
  assert.equal(durable.values.get('openingRequested'), true,
    'the opening request must survive Durable Object reconstruction');
  assertStringMetadata(responseCreates(sent)[0].response.metadata);

  const reconstructed = await testSession({ openingRequested: true });
  assert.equal(await reconstructed.session.requestOpeningResponse(), false);
  assert.equal(responseCreates(reconstructed.sent).length, 0,
    'a reconstructed Durable Object must not repeat an already-requested opening');
}

const prompt = buildLiveCataloguePrompt();
assert.match(prompt, /Before the client has spoken, open once:/,
  'ORIENT must have an explicit empty-conversation branch');
assert.match(prompt, /Planéir, an AI\s+planning companion/,
  'the opening branch must disclose that Planéir is AI');
assert.match(prompt, /only exception to[\s\S]{0,80}reflecting something the client said/,
  'the opening must not pretend a client detail exists');

/* -------------------- continuation waits for response.done AND every output */

{
  const { session, sent } = await testSession();
  session.clientTurnsByItemId.set('item_gate', {
    itemId: 'item_gate', ordinal: 1, status: 'completed', transcript: 'That is all.', storedTurnId: 'turn_gate'
  });
  session.unboundAutoResponseTurnIds.push('item_gate');
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.created', response: { id: 'resp_gate' }
  }));
  const context = session.responseContextsById.get('resp_gate');
  context.assistantDone = true; // speaking before a tool does not settle its result
  session.registerResponseToolCall({ response_id: 'resp_gate', call_id: 'call_gate_a' });
  session.registerResponseToolCall({ response_id: 'resp_gate', call_id: 'call_gate_b' });
  session.markResponseToolOutputDelivered(context, 'call_gate_a');
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.done', response: { id: 'resp_gate', status: 'completed' }
  }));
  assert.equal(responseCreates(sent).length, 0,
    'assistantDone and response.done are insufficient while one tool output is missing');
  session.markResponseToolOutputDelivered(context, 'call_gate_b');
  assert.equal(responseCreates(sent).length, 1,
    'the last delivered tool output must release an already-finished response');
}

/* ------------------------- dedicated three-hop causal-attribution regression */

{
  const { session, sent } = await testSession();
  const jobs = [];
  session.queueReconciliation = (job) => jobs.push(structuredClone(job));
  const rootItemId = 'item_causal_root';
  const storedTurnId = 'turn_causal_root';
  const proposition = 'Any other loans or debts apart from the mortgage?';
  session.lastCompletedAssistantTranscript = proposition;
  session.clientTurnsByItemId.set(rootItemId, {
    itemId: rootItemId,
    ordinal: 1,
    status: 'completed',
    transcript: 'No, none. I have no others.',
    storedTurnId,
    stoppedAt: 100
  });
  session.unboundAutoResponseTurnIds.push(rootItemId);

  await session.handleProviderMessage(JSON.stringify({
    type: 'response.created', response: { id: 'resp_causal_root' }
  }));
  session.responseContextsById.get('resp_causal_root').noteRejectedCount = 1;

  let responseId = 'resp_causal_root';
  for (let hop = 1; hop <= 3; hop += 1) {
    const context = session.responseContextsById.get(responseId);
    const callId = `call_causal_${hop}`;
    session.registerResponseToolCall({ response_id: responseId, call_id: callId });
    session.markResponseToolOutputDelivered(context, callId);
    await session.handleProviderMessage(JSON.stringify({
      type: 'response.done',
      response: { id: responseId, status: 'completed' }
    }));

    const create = responseCreates(sent)[hop - 1];
    assert.ok(create, `tool hop ${hop} must request its continuation`);
    assertStringMetadata(create.response.metadata);
    assert.deepEqual(create.response.metadata, {
      kind: 'tool_continuation',
      parent_response_id: responseId,
      root_response_id: 'resp_causal_root',
      root_item_id: rootItemId,
      continuation_index: String(hop)
    });
    assert.equal(create.response.tool_choice, hop === 3 ? 'none' : 'auto',
      'the third tool result must force a final tools-disabled spoken response');

    // A VAD item arriving before response.created must remain available for
    // its own native response; metadata, never queue position, binds this one.
    if (hop === 1) {
      session.clientTurnsByItemId.set('item_future_vad', {
        itemId: 'item_future_vad', ordinal: 2, status: 'pending', transcript: '', stoppedAt: 200
      });
      session.unboundAutoResponseTurnIds.push('item_future_vad');
    }

    responseId = `resp_causal_continuation_${hop}`;
    await session.handleProviderMessage(JSON.stringify({
      type: 'response.created',
      response: { id: responseId, metadata: create.response.metadata }
    }));
    const continuation = session.responseContextsById.get(responseId);
    assert.equal(continuation.causeItemId, rootItemId,
      `continuation ${hop} must retain the original causal client item`);
    assert.equal(continuation.precedingAssistantTranscript, proposition,
      `continuation ${hop} must retain the proposition the client answered`);
    assert.deepEqual(session.unboundAutoResponseTurnIds, ['item_future_vad'],
      `continuation ${hop} must not consume the next VAD turn`);
  }

  await session.handleProviderMessage(JSON.stringify({
    type: 'response.done',
    response: { id: responseId, status: 'completed' }
  }));
  assert.equal(responseCreates(sent).length, 3,
    'the tools-disabled final response must end the chain without another create');
  assert.deepEqual(jobs, [{
    providerItemId: rootItemId,
    throughTurnId: storedTurnId,
    ordinal: 1,
    trigger: 'rejected_note'
  }], 'reconciliation must be scheduled against the original stored client turn');
}

/* ------------------------------------------ barge-in cancels pending follow-up */

{
  const { session, sent } = await testSession();
  session.clientTurnsByItemId.set('item_barge', {
    itemId: 'item_barge', ordinal: 1, status: 'completed', transcript: 'Carry on.', storedTurnId: 'turn_barge'
  });
  session.unboundAutoResponseTurnIds.push('item_barge');
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.created', response: { id: 'resp_barge' }
  }));
  const context = session.responseContextsById.get('resp_barge');
  session.registerResponseToolCall({ response_id: 'resp_barge', call_id: 'call_barge' });
  await session.handleProviderMessage(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.done', response: { id: 'resp_barge', status: 'completed' }
  }));
  session.markResponseToolOutputDelivered(context, 'call_barge');
  assert.equal(responseCreates(sent).length, 0,
    'a client barge-in must invalidate a not-yet-created tool continuation');
}

{
  const { session, sent } = await testSession();
  session.clientTurnsByItemId.set('item_requested_barge', {
    itemId: 'item_requested_barge',
    ordinal: 1,
    status: 'completed',
    transcript: 'Carry on.',
    storedTurnId: 'turn_requested_barge'
  });
  session.unboundAutoResponseTurnIds.push('item_requested_barge');
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.created', response: { id: 'resp_requested_barge' }
  }));
  const context = session.responseContextsById.get('resp_requested_barge');
  session.registerResponseToolCall({
    response_id: 'resp_requested_barge', call_id: 'call_requested_barge'
  });
  session.markResponseToolOutputDelivered(context, 'call_requested_barge');
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.done', response: { id: 'resp_requested_barge', status: 'completed' }
  }));
  const requested = responseCreates(sent)[0];
  assert.ok(requested, 'the control case must have requested a continuation');
  await session.handleProviderMessage(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.created',
    response: {
      id: 'resp_requested_barge_continuation',
      metadata: requested.response.metadata
    }
  }));
  assert.deepEqual(sent.at(-1), {
    type: 'response.cancel', response_id: 'resp_requested_barge_continuation'
  }, 'a barge-in must cancel a requested continuation that is created after speech begins');
}

/* ------------- a deferred tool output outlives ordinary ledger pressure ----- */

// THE ASR WAIT IS THE DANGEROUS WINDOW. While the causal turn is still
// pending, its response is pinned by pendingSourceItemIds. The finalized
// transcript clears that pin and only THEN drains the deferred tool, so for
// the length of that drain the response owes an undelivered output while
// looking, to the ledger, exactly like a settled one. In a long meeting the
// ledger is already at its bound, and evicting there loses both the causal
// turn the tool call needs for evidence and the continuation that lets
// Planéir speak again.
{
  const { session, sent } = await testSession();
  const jobs = [];
  session.queueReconciliation = (job) => jobs.push(structuredClone(job));
  session.meterTranscription = async () => {};
  session.touch = async () => {};

  // The real dispatcher is database-bound. Stand in for it with the only two
  // things the continuation contract depends on: the response-context lookup
  // executeToolCallWithTranscript performs, and the delivery it reports once
  // the output has reached the provider.
  const dispatched = [];
  session.executeToolCallWithTranscript = async (event, clientTranscript) => {
    const callId = String(event.call_id || '');
    const responseContext = session.responseContextsById.get(String(event.response_id || '')) || null;
    const causalTurn = responseContext?.causeItemId
      ? session.clientTurnsByItemId.get(responseContext.causeItemId)
      : null;
    dispatched.push({
      callId,
      clientTranscript,
      responseFound: Boolean(responseContext),
      causalItemId: causalTurn?.itemId || null,
      assistantReadBack: responseContext?.precedingAssistantTranscript || ''
    });
    // What the real dispatcher records for this turn today: the T1 numeric
    // gate refuses 2500 against "two and a half thousand", and that rejection
    // is what makes the turn reviewable. Asserted directly in
    // check-consumer-live-value-recovery; mirrored here so the causal
    // scheduling this test is about has the same input it has in production.
    if (responseContext) responseContext.noteRejectedCount = 1;
    session.markResponseToolOutputDelivered(responseContext, callId);
  };

  const rootItemId = 'item_deferred_root';
  const proposition = 'And what does that come to each month?';
  const spoken = 'About two and a half thousand.';
  session.lastCompletedAssistantTranscript = proposition;

  // The client stops speaking; ASR has not finished.
  await session.handleProviderMessage(JSON.stringify({
    type: 'input_audio_buffer.speech_stopped', item_id: rootItemId
  }));
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.created', response: { id: 'resp_deferred_root' }
  }));
  const root = session.responseContextsById.get('resp_deferred_root');
  assert.equal(root.causeItemId, rootItemId);
  assert.ok(root.pendingSourceItemIds.has(rootItemId),
    'the response must record that it is still waiting on this turn’s transcript');

  // The model saves against speech the Worker cannot read yet, so the tool is
  // deferred rather than run on empty evidence.
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.function_call_arguments.done',
    response_id: 'resp_deferred_root',
    call_id: 'call_deferred',
    name: 'save_facts',
    arguments: '{"facts":[]}'
  }));
  assert.equal(dispatched.length, 0, 'a tool needing evidence must wait for the finalized transcript');
  assert.ok(root.toolCallIds.has('call_deferred'),
    'a deferred tool call must still be registered against its response');

  await session.handleProviderMessage(JSON.stringify({
    type: 'response.done', response: { id: 'resp_deferred_root', status: 'completed' }
  }));
  assert.equal(responseCreates(sent).length, 0,
    'the undelivered tool output must hold the continuation closed');

  // A long meeting. Ordinary responses drive the ledger past its bound while
  // that transcript is still outstanding.
  for (let index = 0; index < 96; index += 1) {
    const id = `resp_filler_${index}`;
    await session.handleProviderMessage(JSON.stringify({
      type: 'response.created', response: { id }
    }));
    await session.handleProviderMessage(JSON.stringify({
      type: 'response.done', response: { id, status: 'completed' }
    }));
  }
  assert.ok(session.responseContextsById.has('resp_deferred_root'),
    'a pending source transcript must pin its response through ledger pressure');

  // ASR lands. This is the moment the pin is released and the deferred tool
  // is drained, and the drain prunes the ledger on its way through.
  session.clientTurnsByItemId.get(rootItemId).storedTurnId = 'turn_deferred_root';
  await session.handleProviderMessage(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: rootItemId,
    transcript: spoken
  }));

  assert.equal(dispatched.length, 1, 'the finalized transcript must drain the deferred tool exactly once');
  assert.equal(dispatched[0].clientTranscript, spoken,
    'the deferred tool must run against the transcript of its own turn');
  assert.equal(dispatched[0].responseFound, true,
    'a response still owing a tool output must never be evicted from the ledger');
  assert.equal(dispatched[0].causalItemId, rootItemId,
    'the drained tool must keep the client turn its evidence comes from');
  assert.equal(dispatched[0].assistantReadBack, proposition,
    'the drained tool must keep the proposition the client was answering');

  const creates = responseCreates(sent);
  assert.equal(creates.length, 1, 'a drained tool output must request exactly one continuation');
  assert.deepEqual(creates[0].response.metadata, {
    kind: 'tool_continuation',
    parent_response_id: 'resp_deferred_root',
    root_response_id: 'resp_deferred_root',
    root_item_id: rootItemId,
    continuation_index: '1'
  });

  // The continuation belongs to the turn that caused it, and the next VAD
  // turn stays available for its own native response.
  session.registerStoppedClientTurn({ item_id: 'item_next_vad' });
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.created',
    response: { id: 'resp_deferred_continuation', metadata: creates[0].response.metadata }
  }));
  const continuation = session.responseContextsById.get('resp_deferred_continuation');
  assert.equal(continuation.causeItemId, rootItemId,
    'the continuation must answer the turn whose tool result it consumes');
  assert.equal(continuation.precedingAssistantTranscript, proposition);
  assert.deepEqual(session.unboundAutoResponseTurnIds, ['item_next_vad'],
    'a deferred continuation must not consume the next VAD turn');

  assert.deepEqual(jobs, [{
    providerItemId: rootItemId,
    throughTurnId: 'turn_deferred_root',
    ordinal: 1,
    trigger: 'rejected_note'
  }], 'the rejected save must schedule review against the original stored client turn');
}

console.log('consumer live continuation checks passed');
