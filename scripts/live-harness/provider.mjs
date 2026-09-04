/**
 * The provider side of the live sideband, played by the harness.
 *
 * WHAT THIS IS. The live lane's Durable Object never sees a client. It sees a
 * stream of OpenAI Realtime events on an authenticated socket, and everything
 * it does — bind a response to the turn that caused it, defer a tool call until
 * ASR lands, schedule reconciliation once a response settles — is driven by the
 * ORDER of those events. So the only faithful way to drive it offline is to put
 * the real event sequence on the wire, which is what this does.
 *
 * WHAT IT IS NOT. It does not decide anything. Which tools get called and what
 * the assistant says come from the caller: a script (free) or a model (paid).
 * Keeping that decision outside this file is what lets one harness run both.
 *
 * THE EVENT ORDER MATTERS AND IS NOT ARBITRARY:
 *
 *   input_audio_buffer.speech_stopped     the turn exists; the reply clock starts
 *   ...transcription.completed            ASR lands; the turn gains a stored id
 *   response.created                      binds this response to that turn
 *   response.output_audio_transcript.*    speech, scanned by L2/L3 as it arrives
 *   response.function_call_arguments.done tool calls, against the real dispatcher
 *   response.done                         settles the response; may schedule the planner
 *   response.create                       Worker authorizes a post-tool continuation
 *   response.created                      starts that continuation as a NEW response
 *
 * `speech_stopped` MUST precede `response.created`, because that is what puts
 * the turn in the unbound queue the response shifts from. A response created
 * without it has no causal turn, and every evidence-dependent tool then fails
 * closed — which is correct behaviour, and would make a harness that got the
 * order wrong look like a product defect.
 *
 * A FUNCTION RESULT DOES NOT RESUME A RESPONSE. Realtime terminates the model
 * response at its function call. `conversation.item.create` delivers the tool
 * result, but the model cannot inspect it and then speak inside the response
 * that already ended. The Worker must issue response.create and the provider
 * must answer with a distinct response.created. Keeping that boundary here is
 * load-bearing: the old simulator let scripts call `callTool(); speak()` in one
 * response and therefore rendered fluent meetings production could not have.
 */

const AUDIO_DELTA_CHUNK = 24;

export class LiveProviderSimulator {
  constructor({ session, durable, provider }) {
    this.session = session;
    this.durable = durable;
    this.provider = provider;
    this.itemSeq = 0;
    this.responseSeq = 0;
    this.callSeq = 0;
    this.events = [];
    this.consumedResponseCreateIndexes = new Set();
  }

  async send(event) {
    this.events.push(event.type);
    await this.session.handleProviderMessage(JSON.stringify(event));
  }

  /**
   * One tool call, and the result the model is handed back.
   *
   * The result is read off the socket rather than from a return value, because
   * the socket is what the model actually sees. A tool whose result never
   * reaches the provider is indistinguishable from a tool that failed, and only
   * this view can tell them apart.
   */
  async toolCall(responseId, name, args) {
    const callId = `call_${++this.callSeq}`;
    const before = this.provider.sent.length;
    await this.send({
      type: 'response.function_call_arguments.done',
      response_id: responseId,
      call_id: callId,
      name,
      arguments: JSON.stringify(args ?? {})
    });
    const emitted = this.provider.sent.slice(before);
    const output = emitted.find((event) => event?.item?.type === 'function_call_output'
      && event.item.call_id === callId);
    return {
      callId,
      name,
      args: structuredClone(args ?? {}),
      delivered: Boolean(output),
      result: output ? JSON.parse(output.item.output) : null,
      stateItemsPushed: emitted.filter((event) => event?.item?.role === 'system').length
    };
  }

  /**
   * Consume one Worker authorization without mistaking an opening or a stale
   * compliance correction for the continuation of this tool response.
   */
  takeResponseCreate({ kind, parentResponseId = '' }) {
    for (let index = 0; index < this.provider.sent.length; index += 1) {
      if (this.consumedResponseCreateIndexes.has(index)) continue;
      const event = this.provider.sent[index];
      if (event?.type !== 'response.create') continue;
      const metadata = event.response?.metadata || {};
      if (String(metadata.kind || '') !== kind) continue;
      if (parentResponseId
        && String(metadata.parent_response_id || '') !== parentResponseId) continue;
      this.consumedResponseCreateIndexes.add(index);
      return structuredClone(event);
    }
    return null;
  }

  async startResponse(responseCreate = null) {
    const responseId = `resp_${++this.responseSeq}`;
    const response = { id: responseId };
    const metadata = responseCreate?.response?.metadata;
    if (metadata && typeof metadata === 'object') {
      // The real provider echoes response.metadata on response.created. The
      // active lane uses it as the causal envelope for Worker-created turns.
      response.metadata = structuredClone(metadata);
    }
    await this.send({ type: 'response.created', response });
    return {
      responseId,
      responseCreate,
      allowsTools: responseCreate?.response?.tool_choice !== 'none',
      toolEmitted: false,
      spoken: '',
      done: false
    };
  }

  async finishResponse(response) {
    if (!response || response.done) return;
    if (response.spoken) {
      await this.send({
        type: 'response.output_audio_transcript.done',
        response_id: response.responseId,
        item_id: `${response.responseId}_assistant`,
        transcript: response.spoken
      });
    }
    await this.send({
      type: 'response.done',
      response: {
        id: response.responseId,
        status: 'completed',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          input_token_details: { cached_tokens: 0, text_tokens: 0, audio_tokens: 0 },
          output_token_details: { text_tokens: 0, audio_tokens: 0 }
        }
      }
    });
    response.done = true;
    if (response.spoken) {
      await this.send({
        type: 'output_audio_buffer.stopped', response_id: response.responseId,
        event_id: `playback_stopped_${response.responseId}`
      });
    }
  }

  async runResponseChain({ itemId = null, clientText = '', responseCreate = null, act, startedAt }) {
    const chain = {
      current: await this.startResponse(responseCreate),
      responseIds: [],
      responseCreates: responseCreate ? [responseCreate] : [],
      speechParts: [],
      toolCalls: [],
      replyCompleteAt: 0
    };
    chain.responseIds.push(chain.current.responseId);
    const initialResponseId = chain.current.responseId;

    const speak = async (text) => {
      const response = chain.current;
      if (response.done || response.toolEmitted) {
        throw new Error(
          `Harness protocol violation: ${response.responseId} ended with a function call; `
          + 'the Worker must send response.create before the assistant can speak again.'
        );
      }
      const value = String(text || '');
      if (!response.spoken && value) await this.send({
        type: 'output_audio_buffer.started', response_id: response.responseId,
        event_id: `playback_started_${response.responseId}`
      });
      for (let index = 0; index < value.length; index += AUDIO_DELTA_CHUNK) {
        await this.send({
          type: 'response.output_audio_transcript.delta',
          response_id: response.responseId,
          delta: value.slice(index, index + AUDIO_DELTA_CHUNK)
        });
      }
      response.spoken += value;
      chain.speechParts.push(value);
      chain.replyCompleteAt = Date.now();
      return value;
    };

    const callTool = async (name, args) => {
      const response = chain.current;
      if (response.done || response.toolEmitted) {
        throw new Error(
          `Harness protocol violation: ${response.responseId} cannot emit another tool call.`
        );
      }
      if (!response.allowsTools) {
        throw new Error(
          `Harness protocol violation: ${response.responseId} was created with tool_choice none.`
        );
      }
      response.toolEmitted = true;
      const call = await this.toolCall(response.responseId, name, args);
      chain.toolCalls.push(call);

      // Function-call responses settle before the model can see the result.
      // The script resumes only after a Worker-created response has actually
      // started, preserving the convenient callback API without collapsing
      // two provider responses into one impossible response.
      await this.finishResponse(response);
      const continuation = this.takeResponseCreate({
        kind: 'tool_continuation',
        parentResponseId: response.responseId
      });
      if (!continuation) {
        throw new Error(
          `Harness protocol violation: ${response.responseId} emitted ${name}, `
          + 'but the Worker did not send response.create for its continuation.'
        );
      }
      chain.responseCreates.push(continuation);
      chain.current = await this.startResponse(continuation);
      chain.responseIds.push(chain.current.responseId);
      return call;
    };

    const outcome = await act({
      responseId: initialResponseId,
      itemId,
      speak,
      callTool
    }) || {};

    const outcomeSpeech = String(outcome.speech || '');
    if (outcomeSpeech && !outcome.alreadySpoken) await speak(outcomeSpeech);
    chain.replyCompleteAt ||= Date.now();
    await this.finishResponse(chain.current);

    return {
      itemId,
      responseId: initialResponseId,
      finalResponseId: chain.current.responseId,
      responseIds: chain.responseIds,
      responseCreates: chain.responseCreates,
      clientText,
      speech: chain.speechParts.join(''),
      toolCalls: chain.toolCalls,
      replyLatencyMs: chain.replyCompleteAt - startedAt
    };
  }

  /**
   * A complete client turn and the assistant response it triggers.
   *
   * `act` is the caller's decision function. It may call a tool and inspect its
   * result before deciding what to say, but only because callTool waits for the
   * Worker's response.create and resumes the script inside that NEW response.
   */
  async turn({ clientText, act }) {
    const itemId = `item_${++this.itemSeq}`;

    const speechStoppedAt = Date.now();
    await this.send({ type: 'input_audio_buffer.speech_stopped', item_id: itemId });
    await this.send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: itemId,
      transcript: clientText
    });
    return this.runResponseChain({
      itemId,
      clientText,
      act,
      startedAt: speechStoppedAt
    });
  }

  /**
   * Play the one server-authorized opening response. No synthetic client turn
   * is inserted: doing that would make the greeting look causally attributable
   * to evidence the client never supplied.
   */
  async opening({ act }) {
    const responseCreate = this.takeResponseCreate({ kind: 'opening' });
    if (!responseCreate) {
      throw new Error('Harness protocol violation: the Worker did not send response.create for an opening.');
    }
    return this.runResponseChain({
      responseCreate,
      act,
      startedAt: Date.now()
    });
  }
}
