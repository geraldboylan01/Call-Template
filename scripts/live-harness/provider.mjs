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
 *
 * `speech_stopped` MUST precede `response.created`, because that is what puts
 * the turn in the unbound queue the response shifts from. A response created
 * without it has no causal turn, and every evidence-dependent tool then fails
 * closed — which is correct behaviour, and would make a harness that got the
 * order wrong look like a product defect.
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
      delivered: Boolean(output),
      result: output ? JSON.parse(output.item.output) : null,
      stateItemsPushed: emitted.filter((event) => event?.item?.role === 'system').length
    };
  }

  /**
   * A complete client turn and the assistant response it triggers.
   *
   * `act` is the caller's decision function. It receives the response handle and
   * may call tools and inspect their results before deciding what to say, which
   * is exactly the order a real model works in.
   */
  async turn({ clientText, act }) {
    const itemId = `item_${++this.itemSeq}`;
    const responseId = `resp_${++this.responseSeq}`;

    const speechStoppedAt = Date.now();
    await this.send({ type: 'input_audio_buffer.speech_stopped', item_id: itemId });
    await this.send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: itemId,
      transcript: clientText
    });
    await this.send({ type: 'response.created', response: { id: responseId } });

    const toolCalls = [];
    const speak = async (text) => {
      const value = String(text || '');
      for (let index = 0; index < value.length; index += AUDIO_DELTA_CHUNK) {
        await this.send({
          type: 'response.output_audio_transcript.delta',
          response_id: responseId,
          delta: value.slice(index, index + AUDIO_DELTA_CHUNK)
        });
      }
      return value;
    };

    const outcome = await act({
      responseId,
      itemId,
      speak,
      callTool: async (name, args) => {
        const call = await this.toolCall(responseId, name, args);
        toolCalls.push(call);
        return call;
      }
    }) || {};

    const spoken = String(outcome.speech || '');
    if (spoken && !outcome.alreadySpoken) await speak(spoken);
    // The moment the assistant's words are complete is the moment the reply is
    // delivered, so the reply-path measurement ends here — before response.done,
    // which is where the background planner may be scheduled.
    const replyCompleteAt = Date.now();

    await this.send({
      type: 'response.output_audio_transcript.done',
      response_id: responseId,
      item_id: `${responseId}_assistant`,
      transcript: spoken
    });
    await this.send({
      type: 'response.done',
      response: {
        id: responseId,
        status: 'completed',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          input_token_details: { cached_tokens: 0, text_tokens: 0, audio_tokens: 0 },
          output_token_details: { text_tokens: 0, audio_tokens: 0 }
        }
      }
    });

    return {
      itemId,
      responseId,
      clientText,
      speech: spoken,
      toolCalls,
      replyLatencyMs: replyCompleteAt - speechStoppedAt
    };
  }
}
