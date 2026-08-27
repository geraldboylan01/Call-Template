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
  const opening = responseCreates(sent)[0];
  assert.deepEqual(opening.response, {
    tool_choice: 'none',
    metadata: { kind: 'opening', continuation_index: '0' }
  });
  // Load-bearing: the provider echoes this on any error raised for THIS
  // request, which is what lets one failure be attributed to one request.
  assert.match(String(opening.event_id || ''), /^planeir_opening_/,
    'every Worker-created response must carry a correlatable client event id');
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
    // The production dispatcher schedules from HERE, not only from
    // response.done — a save whose evidence was deferred finishes long after
    // its response did. Reproducing that call is the point: without it this
    // test exercises a scheduling path the live lane does not use, and the
    // race it is meant to pin goes unobserved.
    if (responseContext?.done && !session.awaitsContinuationChain(responseContext)) {
      session.maybeScheduleReconciliation(responseContext);
    }
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

  // The chain is still open here: the drained save earned a continuation, and
  // reviewing before that continuation settles would review the turn against
  // part of its own evidence.
  assert.deepEqual(jobs, [], 'an open continuation chain must not be reviewed yet');
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.done',
    response: { id: 'resp_deferred_continuation', status: 'completed' }
  }));
  assert.deepEqual(jobs, [{
    providerItemId: rootItemId,
    throughTurnId: 'turn_deferred_root',
    ordinal: 1,
    trigger: 'rejected_note'
  }], 'the settled chain must review the original stored client turn, carrying the '
    + 'rejection its deferred save reported after that hop had already finished');
}

/* ------------- one review, and only after the whole chain has settled ------ */

// A THREE-HOP CHAIN IS ONE CONVERSATIONAL TURN, NOT THREE.
//
// Reconciliation used to be scheduled at the FIRST response.done of a chain,
// before hops two and three had saved anything. Because queueReconciliation
// deduplicates by turn id, the later saves could never trigger another review
// of the same causal turn — so a dense answer was reviewed against a third of
// its own evidence and the rest was silently never looked at.
{
  const { session, sent } = await testSession();
  const jobs = [];
  session.queueReconciliation = (job) => jobs.push({ ...structuredClone(job), atHop: hop });
  const rootItemId = 'item_chain_root';
  session.lastCompletedAssistantTranscript = 'Tell me about the pensions and the mortgage.';
  session.clientTurnsByItemId.set(rootItemId, {
    itemId: rootItemId,
    ordinal: 1,
    status: 'completed',
    transcript: 'Mine is a hundred and eighty grand, hers is ninety, and the mortgage is three forty.',
    storedTurnId: 'turn_chain_root',
    stoppedAt: 100
  });
  session.unboundAutoResponseTurnIds.push(rootItemId);

  let hop = 0;
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.created', response: { id: 'resp_chain_root' }
  }));
  session.responseContextsById.get('resp_chain_root').noteRejectedCount = 1;

  let responseId = 'resp_chain_root';
  for (hop = 1; hop <= 3; hop += 1) {
    const context = session.responseContextsById.get(responseId);
    const callId = `call_chain_${hop}`;
    session.registerResponseToolCall({ response_id: responseId, call_id: callId });
    session.markResponseToolOutputDelivered(context, callId);
    await session.handleProviderMessage(JSON.stringify({
      type: 'response.done', response: { id: responseId, status: 'completed' }
    }));
    assert.equal(jobs.length, 0,
      `hop ${hop} still owes a continuation, so no review may be scheduled yet`);
    const create = responseCreates(sent)[hop - 1];
    responseId = `resp_chain_continuation_${hop}`;
    await session.handleProviderMessage(JSON.stringify({
      type: 'response.created',
      response: { id: responseId, metadata: create.response.metadata }
    }));
  }

  // The third continuation is tools-disabled, so it can only speak. THAT is
  // when the turn is finished and its evidence is complete.
  hop = 4;
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.done', response: { id: responseId, status: 'completed' }
  }));
  assert.equal(jobs.length, 1,
    'the settled chain must schedule exactly one review');
  assert.equal(jobs[0].atHop, 4,
    'the review must be scheduled once the chain settles, not at the first hop');
  assert.equal(jobs[0].throughTurnId, 'turn_chain_root');
}

// A barge-in ends the chain without a further response. The turn still has to
// be reviewed, or an interrupted answer is never looked at again.
{
  const { session } = await testSession();
  const jobs = [];
  session.queueReconciliation = (job) => jobs.push(structuredClone(job));
  session.clientTurnsByItemId.set('item_cut', {
    itemId: 'item_cut',
    ordinal: 1,
    status: 'completed',
    transcript: 'My pension is worth about three hundred thousand.',
    storedTurnId: 'turn_cut',
    stoppedAt: 100
  });
  session.unboundAutoResponseTurnIds.push('item_cut');
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.created', response: { id: 'resp_cut' }
  }));
  const context = session.responseContextsById.get('resp_cut');
  context.noteRejectedCount = 1;
  session.registerResponseToolCall({ response_id: 'resp_cut', call_id: 'call_cut' });
  session.markResponseToolOutputDelivered(context, 'call_cut');
  await session.handleProviderMessage(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.done', response: { id: 'resp_cut', status: 'completed' }
  }));
  assert.equal(jobs.length, 1,
    'an interrupted chain gets no continuation, so its turn must be reviewed at once');
}

/* --------- a new client turn wins, whatever key or microphone made it ----- */

// TYPED INPUT IS A BARGE-IN TOO. The client typing an answer is the same
// event as the client speaking one: they have moved on, and a queued tool
// continuation would answer a question they have already left behind. Only
// speech_started invalidated the chain, so a typed turn raced it.
{
  const { session, sent } = await testSession();
  session.queueReconciliation = () => {};
  session.meterTranscription = async () => {};
  session.touch = async () => {};
  session.clientTurnsByItemId.set('item_typed_root', {
    itemId: 'item_typed_root',
    ordinal: 1,
    status: 'completed',
    transcript: 'Carry on.',
    storedTurnId: 'turn_typed_root'
  });
  session.unboundAutoResponseTurnIds.push('item_typed_root');
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.created', response: { id: 'resp_typed' }
  }));
  const context = session.responseContextsById.get('resp_typed');
  session.registerResponseToolCall({ response_id: 'resp_typed', call_id: 'call_typed' });

  await session.handleProviderMessage(JSON.stringify({
    type: 'conversation.item.created',
    item: {
      id: 'item_typed_next',
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Actually, forget the pension — what about the mortgage?' }]
    }
  }));

  await session.handleProviderMessage(JSON.stringify({
    type: 'response.done', response: { id: 'resp_typed', status: 'completed' }
  }));
  session.markResponseToolOutputDelivered(context, 'call_typed');
  assert.equal(responseCreates(sent).length, 0,
    'a typed client turn must invalidate a pending tool continuation, exactly as speech does');
}

// The opening is requested before any response exists to attach it to. A
// client who speaks immediately, in that window, used to get talked over: the
// greeting had no context yet, so there was nothing for barge-in to invalidate.
{
  const { session, sent } = await testSession();
  assert.equal(await session.requestOpeningResponse(), true);
  await session.handleProviderMessage(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.created',
    response: { id: 'resp_opening', metadata: { kind: 'opening', continuation_index: '0' } }
  }));
  assert.deepEqual(sent.at(-1), {
    type: 'response.cancel', response_id: 'resp_opening'
  }, 'a client who speaks before the greeting arrives must not be spoken over');
}

/* ---- a refused request must not poison the continuations that follow it --- */

// The Worker tracked outstanding server-requested responses as a COUNT. A
// provider error on one of them never decremented it, so the count stayed
// above zero forever; the next barge-in then marked "the outstanding request"
// superseded, and that verdict landed on the next legitimate continuation
// instead — cancelling it, and every one after it, for the rest of the call.
{
  const { session, sent } = await testSession();
  session.meta = { ...session.meta };
  session.terminalize = async () => {};
  session.clientTurnsByItemId.set('item_poison', {
    itemId: 'item_poison', ordinal: 1, status: 'completed',
    transcript: 'Go on.', storedTurnId: 'turn_poison'
  });
  session.unboundAutoResponseTurnIds.push('item_poison');
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.created', response: { id: 'resp_poison_a' }
  }));
  const first = session.responseContextsById.get('resp_poison_a');
  session.registerResponseToolCall({ response_id: 'resp_poison_a', call_id: 'call_poison_a' });
  session.markResponseToolOutputDelivered(first, 'call_poison_a');
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.done', response: { id: 'resp_poison_a', status: 'completed' }
  }));
  assert.equal(responseCreates(sent).length, 1, 'the first continuation must be requested');

  // The provider refuses to create it, and the client then speaks.
  const refused = responseCreates(sent)[0];
  await session.handleProviderMessage(JSON.stringify({
    type: 'error',
    error: { code: 'conversation_already_has_active_response', event_id: refused.event_id }
  }));
  // Nothing will ever create that response, so nothing else can retire it.
  // Correlating the error to its own request is what keeps the bookkeeping
  // from growing for the rest of a long meeting — and what stops an unrelated
  // failure clearing requests it has nothing to do with.
  assert.equal(session.pendingServerResponses.size, 0,
    'a request the provider refused must not stay outstanding forever');
  await session.handleProviderMessage(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));

  // A completely new turn, with its own tool call and its own continuation.
  session.clientTurnsByItemId.set('item_after', {
    itemId: 'item_after', ordinal: 2, status: 'completed',
    transcript: 'My pension is about three hundred thousand.', storedTurnId: 'turn_after'
  });
  session.unboundAutoResponseTurnIds.push('item_after');
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.created', response: { id: 'resp_poison_b' }
  }));
  const second = session.responseContextsById.get('resp_poison_b');
  session.registerResponseToolCall({ response_id: 'resp_poison_b', call_id: 'call_poison_b' });
  session.markResponseToolOutputDelivered(second, 'call_poison_b');
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.done', response: { id: 'resp_poison_b', status: 'completed' }
  }));
  const request = responseCreates(sent).at(-1);
  assert.equal(request.response.metadata.parent_response_id, 'resp_poison_b');
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.created',
    response: { id: 'resp_poison_b_continuation', metadata: request.response.metadata }
  }));
  assert.notDeepEqual(sent.at(-1), {
    type: 'response.cancel', response_id: 'resp_poison_b_continuation'
  }, 'a refused earlier request must not cancel a later, legitimate continuation');
}

/* ------------- reserved metadata is the Worker's own vocabulary ------------ */

// `kind` decides which client turn a response answers. A response carrying it
// that the Worker never asked for could bind itself to any earlier turn and
// schedule that turn's review against speech it had nothing to do with.
{
  const { session } = await testSession();
  const jobs = [];
  session.queueReconciliation = (job) => jobs.push(job);
  session.clientTurnsByItemId.set('item_unrelated', {
    itemId: 'item_unrelated', ordinal: 1, status: 'completed',
    transcript: 'My pension is worth three hundred thousand.', storedTurnId: 'turn_unrelated'
  });
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.created',
    response: {
      id: 'resp_unsolicited',
      metadata: {
        kind: 'tool_continuation',
        parent_response_id: 'resp_never_existed',
        root_response_id: 'resp_never_existed',
        root_item_id: 'item_unrelated',
        continuation_index: '1'
      }
    }
  }));
  const context = session.responseContextsById.get('resp_unsolicited');
  assert.equal(context.responseKind, 'auto',
    'metadata the Worker never issued must not be honoured as a continuation');
  assert.equal(context.causeItemId, null,
    'an unsolicited response must not adopt an earlier client turn as its cause');
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.done', response: { id: 'resp_unsolicited', status: 'completed' }
  }));
  assert.deepEqual(jobs, [],
    'an unsolicited response must not schedule review of a turn it never answered');
}

// A duplicate response.created is the SAME response, and must not be mistaken
// for an unsolicited one on its second delivery.
{
  const { session, sent } = await testSession();
  session.clientTurnsByItemId.set('item_dup', {
    itemId: 'item_dup', ordinal: 1, status: 'completed', transcript: 'Go on.', storedTurnId: 'turn_dup'
  });
  session.unboundAutoResponseTurnIds.push('item_dup');
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.created', response: { id: 'resp_dup_root' }
  }));
  const root = session.responseContextsById.get('resp_dup_root');
  session.registerResponseToolCall({ response_id: 'resp_dup_root', call_id: 'call_dup' });
  session.markResponseToolOutputDelivered(root, 'call_dup');
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.done', response: { id: 'resp_dup_root', status: 'completed' }
  }));
  const created = {
    type: 'response.created',
    response: { id: 'resp_dup_cont', metadata: responseCreates(sent)[0].response.metadata }
  };
  await session.handleProviderMessage(JSON.stringify(created));
  await session.handleProviderMessage(JSON.stringify(created));
  const context = session.responseContextsById.get('resp_dup_cont');
  assert.equal(context.responseKind, 'tool_continuation',
    'a repeated response.created is the same response, not an unsolicited one');
  assert.equal(context.causeItemId, 'item_dup');
}

/* -------- one failed request, one settled chain, nothing else disturbed ---- */

// Retiring EVERY outstanding request on ANY error was wrong twice over.
{
  const { session, sent } = await testSession();
  await session.requestOpeningResponse();
  await session.handleProviderMessage(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
  await session.handleProviderMessage(JSON.stringify({
    type: 'error', error: { code: 'some_unrelated_failure' }
  }));
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.created',
    response: { id: 'resp_greeting', metadata: { kind: 'opening', continuation_index: '0' } }
  }));
  assert.deepEqual(sent.at(-1), {
    type: 'response.cancel', response_id: 'resp_greeting'
  }, 'an unrelated error must not erase a pending opening\'s supersession');
}

// The other half: a request that genuinely failed leaves its chain waiting for
// a continuation that will never arrive. That would hold the turn's review —
// and the confirmation barrier behind it — shut for the rest of the meeting.
{
  const { session, sent } = await testSession();
  const jobs = [];
  session.queueReconciliation = (job) => jobs.push(structuredClone(job));
  session.clientTurnsByItemId.set('item_failed', {
    itemId: 'item_failed', ordinal: 1, status: 'completed',
    transcript: 'My pension is worth three hundred thousand.', storedTurnId: 'turn_failed'
  });
  session.unboundAutoResponseTurnIds.push('item_failed');
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.created', response: { id: 'resp_failed' }
  }));
  const context = session.responseContextsById.get('resp_failed');
  context.noteRejectedCount = 1;
  session.registerResponseToolCall({ response_id: 'resp_failed', call_id: 'call_failed' });
  session.markResponseToolOutputDelivered(context, 'call_failed');
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.done', response: { id: 'resp_failed', status: 'completed' }
  }));
  const request = responseCreates(sent).at(-1);
  assert.equal(jobs.length, 0, 'the chain is still open while its continuation is pending');
  await session.handleProviderMessage(JSON.stringify({
    type: 'error',
    error: { code: 'conversation_already_has_active_response', event_id: request.event_id }
  }));
  assert.equal(jobs.length, 1,
    'a continuation that will never arrive must settle its chain and let the turn be reviewed');
  assert.equal(jobs[0].throughTurnId, 'turn_failed');
}

// MATCHING AN OUTSTANDING PARENT IS NOT ATTRIBUTION. A response can name the
// parent the Worker really is waiting on, and still carry root_* fields
// pointing at a different client turn — which would make it answer, and
// schedule review of, a turn it has nothing to do with. The Worker recorded
// the chain when it asked; that record is the only authority on whose turn
// this is.
{
  const { session, sent } = await testSession();
  const jobs = [];
  session.queueReconciliation = (job) => jobs.push(structuredClone(job));
  session.lastCompletedAssistantTranscript = 'And what is the pension worth?';
  session.clientTurnsByItemId.set('item_victim', {
    itemId: 'item_victim', ordinal: 1, status: 'completed',
    transcript: 'My pension is worth three hundred thousand.', storedTurnId: 'turn_victim'
  });
  session.clientTurnsByItemId.set('item_real', {
    itemId: 'item_real', ordinal: 2, status: 'completed',
    transcript: 'Yes, go on.', storedTurnId: 'turn_real'
  });
  session.unboundAutoResponseTurnIds.push('item_real');
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.created', response: { id: 'resp_real' }
  }));
  const root = session.responseContextsById.get('resp_real');
  root.noteRejectedCount = 1;
  session.registerResponseToolCall({ response_id: 'resp_real', call_id: 'call_real' });
  session.markResponseToolOutputDelivered(root, 'call_real');
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.done', response: { id: 'resp_real', status: 'completed' }
  }));
  assert.equal(responseCreates(sent).at(-1).response.metadata.root_item_id, 'item_real');

  // Correct parent — so the request check passes — but forged roots.
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.created',
    response: {
      id: 'resp_forged',
      metadata: {
        kind: 'tool_continuation',
        parent_response_id: 'resp_real',
        root_response_id: 'resp_does_not_exist',
        root_item_id: 'item_victim',
        continuation_index: '1'
      }
    }
  }));
  const forged = session.responseContextsById.get('resp_forged');
  assert.equal(forged.causeItemId, 'item_real',
    'the causal turn must come from the request the Worker issued, never from the response');
  assert.equal(forged.precedingAssistantTranscript, 'And what is the pension worth?',
    'the inherited proposition must come from the Worker-held chain too');
  await session.handleProviderMessage(JSON.stringify({
    type: 'response.done', response: { id: 'resp_forged', status: 'completed' }
  }));
  assert.deepEqual(jobs.map((job) => job.throughTurnId), ['turn_real'],
    'forged roots must not redirect a review onto an unrelated turn');
}

console.log('consumer live continuation checks passed');
