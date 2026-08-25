#!/usr/bin/env node

/**
 * THE HARNESS MUST NOT CERTIFY A CONVERSATION THE REAL PROVIDER CANNOT HAVE.
 *
 * A Realtime response ends when it emits a function call. Delivering a
 * function_call_output adds the result to the conversation, but it does not
 * let that finished response start speaking again. Only a new response.create
 * does that. These checks pin that protocol boundary in the simulator itself,
 * independently of the Durable Object implementation it usually drives.
 */

import assert from 'node:assert/strict';

import { LiveProviderSimulator } from './live-harness/provider.mjs';

const pass = (message) => console.info(`[ConsumerLiveHarness] PASS: ${message}`);

function fakeLane({ continueAfterTools }) {
  const provider = { sent: [] };
  const inbound = [];
  const toolResponses = new Set();
  let rootResponseId = '';
  let rootItemId = '';
  let continuationIndex = 0;

  const session = {
    async handleProviderMessage(text) {
      const event = JSON.parse(text);
      inbound.push(event);
      if (event.type === 'input_audio_buffer.speech_stopped') {
        rootItemId ||= String(event.item_id || '');
        return;
      }
      if (event.type === 'response.created') {
        rootResponseId ||= String(event.response?.id || '');
        return;
      }
      if (event.type === 'response.function_call_arguments.done') {
        toolResponses.add(String(event.response_id || ''));
        provider.sent.push({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: event.call_id,
            output: JSON.stringify({ ok: true, saved: [`saved_${event.call_id}`] })
          }
        });
        return;
      }
      if (event.type !== 'response.done'
        || !toolResponses.has(String(event.response?.id || ''))
        || !continueAfterTools) return;

      continuationIndex += 1;
      provider.sent.push({
        type: 'response.create',
        response: {
          tool_choice: continuationIndex >= 3 ? 'none' : 'auto',
          metadata: {
            kind: 'tool_continuation',
            parent_response_id: String(event.response.id),
            root_response_id: rootResponseId,
            root_item_id: rootItemId,
            continuation_index: String(continuationIndex)
          }
        }
      });
    }
  };

  return {
    simulator: new LiveProviderSimulator({ session, durable: {}, provider }),
    provider,
    inbound
  };
}

/* ============================ a tool result alone cannot resume one response */

{
  const rig = fakeLane({ continueAfterTools: false });
  await assert.rejects(
    rig.simulator.turn({
      clientText: 'My pension is worth 100,000.',
      act: async ({ callTool }) => {
        await callTool('save_facts', { facts: [] });
        return { speech: 'Noted.' };
      }
    }),
    /response\.create/,
    'without a Worker continuation, the scripted assistant must not speak after its tool call'
  );
  assert.equal(
    rig.inbound.filter((event) => event.type === 'response.output_audio_transcript.delta').length,
    0,
    'the impossible same-response speech must never reach the simulated provider wire'
  );
  pass('function_call_output alone cannot authorize post-tool speech');
}

/* ================ each tool continuation is a distinct, metadata-bound response */

{
  const rig = fakeLane({ continueAfterTools: true });
  const turn = await rig.simulator.turn({
    clientText: 'I have three facts to save.',
    act: async ({ callTool }) => {
      await callTool('save_facts', { facts: [{ factId: 'first' }] });
      await callTool('save_facts', { facts: [{ factId: 'second' }] });
      await callTool('save_facts', { facts: [{ factId: 'third' }] });
      await assert.rejects(
        callTool('save_facts', { facts: [{ factId: 'fourth' }] }),
        /tool_choice none/,
        'the final tools-disabled continuation must enforce the Worker chain budget'
      );
      return { speech: 'All three are recorded.' };
    }
  });

  assert.equal(turn.responseIds.length, 4,
    'one native response plus three Worker-created continuations must form the chain');
  assert.equal(turn.toolCalls.length, 3);

  const created = rig.inbound.filter((event) => event.type === 'response.created');
  assert.equal(created.length, 4);
  for (let index = 1; index < created.length; index += 1) {
    const metadata = created[index].response.metadata;
    assert.equal(metadata.kind, 'tool_continuation');
    assert.equal(metadata.parent_response_id, created[index - 1].response.id,
      'each continuation must name the response whose tool call ended it');
    assert.equal(metadata.root_response_id, created[0].response.id);
    assert.equal(metadata.root_item_id, turn.itemId,
      'every continuation must retain the original causal client item');
    assert.equal(metadata.continuation_index, String(index));
  }

  const deltas = rig.inbound.filter((event) => (
    event.type === 'response.output_audio_transcript.delta'
  ));
  assert.ok(deltas.length > 0);
  assert.ok(deltas.every((event) => event.response_id === created.at(-1).response.id),
    'speech after three tools must belong only to the final Worker-created response');
  assert.equal(turn.speech, 'All three are recorded.');
  pass('three consecutive tools require three distinct continuations with causal metadata intact');
}

/* ============================================= an opening is server-authorized */

{
  const rig = fakeLane({ continueAfterTools: true });
  const opening = {
    type: 'response.create',
    response: {
      tool_choice: 'none',
      metadata: { kind: 'opening', continuation_index: '0' }
    }
  };
  rig.provider.sent.push(opening);

  const result = await rig.simulator.opening({
    act: async () => ({ speech: 'Hello, I’m Planéir. What brought you here today?' })
  });
  const created = rig.inbound.find((event) => event.type === 'response.created');
  assert.deepEqual(created.response.metadata, opening.response.metadata,
    'the provider response must echo the Worker opening metadata verbatim');
  assert.equal(result.speech, 'Hello, I’m Planéir. What brought you here today?');
  pass('a Worker-created opening is represented as its own metadata-bound response');
}

console.info('check-consumer-live-harness: 3 protocol checks passed.');
