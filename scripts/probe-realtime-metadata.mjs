/**
 * Provider probe for the two assumptions Phase 1's continuation design rests on.
 *
 * The live-lane harness cannot prove either of these, because the harness was
 * written to behave the way we assumed. This talks to the real service.
 *
 * A. Does `response.create` metadata come back on `response.created`?
 *    The whole causal chain — root client item, parent response, continuation
 *    index — is carried in `response.metadata`. If the service drops it, every
 *    continuation loses its causal binding and reconciliation is scheduled
 *    against the wrong turn (or not at all).
 *
 * B. Does a response terminate at its function call?
 *    If the model can keep speaking after a tool result without a new
 *    `response.create`, the missing-continuation diagnosis is wrong.
 *
 * Cost control: text-only output, one short turn, tiny max_output_tokens. This
 * should cost a fraction of a cent. It never sends audio.
 *
 * Limitation: `output_audio_buffer.started/stopped/cleared` are WebRTC-only and
 * cannot be observed over this WebSocket. The orb lifecycle still needs the
 * browser deployment proof.
 *
 *   node --env-file-if-exists=.env.local scripts/probe-realtime-metadata.mjs
 *   REALTIME_MODEL=gpt-realtime node --env-file-if-exists=.env.local scripts/probe-realtime-metadata.mjs
 */

const KEY = String(process.env.OPENAI_API_KEY || '').trim();
const MODEL = String(process.env.REALTIME_MODEL || 'gpt-realtime').trim();
const TIMEOUT_MS = 45_000;

if (!KEY) {
  console.error('OPENAI_API_KEY is not set. Run with --env-file-if-exists=.env.local from the repo root.');
  process.exit(2);
}

const SENT_METADATA = Object.freeze({
  kind: 'tool_continuation',
  parent_response_id: 'resp_probe_parent',
  root_response_id: 'resp_probe_root',
  root_item_id: 'item_probe_root',
  continuation_index: '1'
});

const events = [];
let socket;
let finished = false;

const log = (...args) => console.log(...args);
const send = (payload) => socket.send(JSON.stringify(payload));

function done(code) {
  if (finished) return;
  finished = true;
  try { socket?.close(); } catch { /* closing anyway */ }
  report();
  process.exit(code);
}

function firstOfType(type) {
  return events.find((event) => event?.type === type) || null;
}

function report() {
  log('\n================ RESULT ================\n');

  // ---- A. metadata echo -------------------------------------------------
  const created = firstOfType('response.created');
  const finalDone = events.filter((e) => e?.type === 'response.done').at(-1) || null;
  const createdMeta = created?.response?.metadata ?? null;
  const doneMeta = finalDone?.response?.metadata ?? null;

  log('A. response.metadata echo');
  log('   sent on response.create :', JSON.stringify(SENT_METADATA));
  log('   echoed on response.created:', JSON.stringify(createdMeta));
  log('   echoed on response.done   :', JSON.stringify(doneMeta));

  const echoed = createdMeta && Object.entries(SENT_METADATA)
    .every(([key, value]) => String(createdMeta[key] ?? '') === value);
  log(echoed
    ? '   => VERDICT: PASS. The causal metadata design holds.'
    : '   => VERDICT: FAIL. bindResponseContext() cannot recover the chain from response.created.');

  if (!echoed && created) {
    log('\n   Full response.created payload, for designing a fallback correlation:');
    log('   ' + JSON.stringify(created, null, 2).split('\n').join('\n   '));
  }

  // ---- B. function call terminates the response --------------------------
  const callDone = firstOfType('response.function_call_arguments.done');
  log('\nB. does a function call terminate its response?');
  if (!callDone) {
    log('   INCONCLUSIVE: the model never called the tool, so this run proves nothing about B.');
    log('   Re-run; if it keeps declining to call, the instruction needs strengthening.');
  } else {
    const order = events.map((e) => e.type);
    const callIndex = order.indexOf('response.function_call_arguments.done');
    const doneIndex = order.indexOf('response.done', callIndex);
    const spokeAfterOutput = events
      .slice(order.indexOf('__probe.output_submitted__'))
      .some((e) => e?.type === 'response.output_text.delta' || e?.type === 'response.text.delta');
    log('   response.done followed the call:', doneIndex > callIndex ? 'yes' : 'no');
    log('   model produced more text after function_call_output WITHOUT response.create:',
      spokeAfterOutput ? 'YES' : 'no');
    log(spokeAfterOutput
      ? '   => VERDICT: FAIL. The missing-continuation diagnosis is wrong; the model continued on its own.'
      : '   => VERDICT: PASS. The Worker must send response.create, exactly as Phase 1 assumes.');
  }

  log('\n---- event order ----');
  log(events.map((e) => e.type).join('\n'));
  log('\nNot covered here: output_audio_buffer.* is WebRTC-only and still needs the browser proof.');
}

log(`Connecting to the Realtime API (model: ${MODEL})…`);

socket = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`, {
  headers: { Authorization: `Bearer ${KEY}` }
});

const timer = setTimeout(() => {
  log('\nTimed out waiting for the provider.');
  done(1);
}, TIMEOUT_MS);

socket.addEventListener('open', () => {
  log('Connected. Configuring a text-only session with one tool.\n');
  send({
    type: 'session.update',
    session: {
      type: 'realtime',
      output_modalities: ['text'],
      instructions:
        'You are a probe. When the user speaks, you MUST call the record_probe tool '
        + 'immediately with value "x". Do not answer in words before calling it.',
      tools: [{
        type: 'function',
        name: 'record_probe',
        description: 'Record the probe value. You must call this.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['value'],
          properties: { value: { type: 'string' } }
        }
      }],
      tool_choice: 'required',
      max_output_tokens: 200
    }
  });

  send({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Record the probe.' }]
    }
  });

  // The metadata under test rides on this response.create.
  send({ type: 'response.create', response: { metadata: { ...SENT_METADATA } } });
});

socket.addEventListener('message', (message) => {
  let event;
  try { event = JSON.parse(message.data); } catch { return; }
  events.push(event);

  if (event.type === 'error' || event.type === 'response.failed') {
    log('PROVIDER ERROR:', JSON.stringify(event, null, 2));
    clearTimeout(timer);
    done(1);
    return;
  }

  if (event.type !== 'response.output_text.delta' && event.type !== 'response.text.delta') {
    log('  <-', event.type);
  }

  // Submit the tool output, then deliberately DO NOTHING. If the model speaks
  // after this without a response.create, assumption B is false.
  if (event.type === 'response.function_call_arguments.done') {
    log('\n  Tool call received. Submitting function_call_output and then staying silent');
    log('  for 6s to see whether the model continues on its own…\n');
    send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: event.call_id,
        output: JSON.stringify({ ok: true })
      }
    });
    events.push({ type: '__probe.output_submitted__' });
    setTimeout(() => {
      clearTimeout(timer);
      done(0);
    }, 6_000);
  }
});

socket.addEventListener('error', (error) => {
  log('Socket error:', error?.message || error);
  clearTimeout(timer);
  done(1);
});

socket.addEventListener('close', () => {
  if (!finished) {
    clearTimeout(timer);
    done(0);
  }
});
