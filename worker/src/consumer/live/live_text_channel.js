/**
 * The typed lane's mouth.
 *
 * THIS IS THE LIVE LANE, NOT THE V2 AGENT TRANSPORT. `agent_text_channel.js`
 * looks like this file and is not this file: it speaks for the archived v2 core
 * and produces MeetingBriefV2. This one speaks for the same engine production
 * voice runs — the direct-module planner, MeetingBriefV3, the live catalogue
 * prompt and the live toolset. See D-07 and D-08 in the parity contract.
 *
 * It is deliberately not a second prompt pack:
 *
 *   - instructions come from `buildLiveCataloguePrompt({ channel: 'text' })`,
 *     which differs from the voice string ONLY in its delivery-shape sections;
 *   - tools come from `liveToolsForConfig` — the same list voice is given;
 *   - tool calls are dispatched by the caller into the SAME Durable Object
 *     barrier voice uses, not to a handler of this file's own.
 *
 * It renders words. It decides nothing: not which module is relevant, not what
 * a figure means, not whether a plan may run.
 *
 * THE READ-BACK IS NOT RENDERED HERE. When a plan is certified the Durable
 * Object writes the certified `confirmationPrompt` verbatim as the assistant
 * turn and this file is never asked. That is why the typed lane needs no
 * transcript-equality check: the model is never given the chance to paraphrase
 * it. See `deliverCertifiedReadback` in live_session.js.
 */

import { ConsumerError } from '../errors.js';
import { buildLiveCataloguePrompt } from './catalogue_prompt.js';
import { liveToolsForConfig } from './live_provider.js';

const RENDERER_TIMEOUT_MS = 20_000;
const RENDERER_MAX_OUTPUT_TOKENS = 400;
const MAX_ASSISTANT_CHARACTERS = 1_200;
const MAX_TRANSCRIPT_TURNS = 16;
const MAX_TRANSCRIPT_TURN_CHARACTERS = 600;

/**
 * A typed turn always needs a reply, and the client is looking at the screen
 * waiting for one. Two passes is the ceiling: one tool call, then words.
 */
const MAX_TOOL_PASSES = 2;

function transcriptInput(turns) {
  return (Array.isArray(turns) ? turns : [])
    .slice(-MAX_TRANSCRIPT_TURNS)
    .map((turn) => {
      const text = String(turn?.transcript || '').replace(/\s+/g, ' ').trim()
        .slice(0, MAX_TRANSCRIPT_TURN_CHARACTERS);
      if (!text) return null;
      return { role: turn?.role === 'user' ? 'user' : 'assistant', content: text };
    })
    .filter(Boolean);
}

/**
 * Bounded, and silent about its own failures.
 *
 * A link is refused outright: nothing in this conversation has any business
 * sending the client somewhere, and a hallucinated one is the cheapest possible
 * phishing surface.
 */
export function boundedAssistantText(value) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!text || text.length > MAX_ASSISTANT_CHARACTERS) return '';
  if (/https?:\/\//i.test(text)) return '';
  return text;
}

/**
 * Token counts in the shape `recordRealtimeUsage` already stores.
 *
 * Deliberately NOT a euro figure. Voice meters tokens and lets the shared
 * pricing version convert them; a typed lane that pre-converted would put a
 * second cost model in the same table and one of them would drift.
 */
function textUsageTokens(usage) {
  const cached = Number(usage?.input_tokens_details?.cached_tokens || 0);
  return {
    inputTextTokens: Math.max(0, Number(usage?.input_tokens || 0) - cached),
    cachedTextTokens: cached,
    outputTextTokens: Number(usage?.output_tokens || 0)
  };
}

function addTokens(into, usage) {
  const next = textUsageTokens(usage);
  into.inputTextTokens += next.inputTextTokens;
  into.cachedTextTokens += next.cachedTextTokens;
  into.outputTextTokens += next.outputTextTokens;
  return into;
}

function responseText(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }
  for (const item of response?.output || []) {
    if (item?.type !== 'message') continue;
    for (const content of item.content || []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') return content.text.trim();
    }
  }
  return '';
}

function responseToolCall(response) {
  const item = (Array.isArray(response?.output) ? response.output : [])
    .find((entry) => entry?.type === 'function_call' && typeof entry.name === 'string');
  if (!item) return null;
  return {
    name: item.name,
    // Kept as the raw string: the Durable Object's tool path parses arguments
    // itself and must see exactly what the model emitted, not a re-encoding.
    argumentsJson: typeof item.arguments === 'string' ? item.arguments : '{}',
    callId: String(item.call_id || item.id || '')
  };
}

async function callResponsesApi({ env, config, instructions, tools, input, signal }) {
  const key = typeof env.OPENAI_API_KEY === 'string' ? env.OPENAI_API_KEY.trim() : '';
  if (!key) throw new ConsumerError(503, 'live_text_renderer_unconfigured', 'The typed meeting is not configured.');
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'X-Client-Request-Id': crypto.randomUUID()
    },
    body: JSON.stringify({
      model: config.defaultModel,
      store: false,
      reasoning: { effort: 'low' },
      max_output_tokens: RENDERER_MAX_OUTPUT_TOKENS,
      instructions,
      tools: tools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      })),
      tool_choice: 'auto',
      parallel_tool_calls: false,
      input
    }),
    signal
  });
  if (!response.ok) {
    response.body?.cancel?.().catch?.(() => {});
    throw new ConsumerError(502, 'live_text_renderer_failed', 'The typed meeting could not produce a reply.');
  }
  return response.json();
}

/**
 * Produce the assistant's next typed message.
 *
 * `dispatchTool` is supplied by the Durable Object and runs the real barrier —
 * idempotency ledger, approval classification, offer-token binding, certificate
 * re-verification. This file never inspects what it returns beyond handing it
 * back to the model.
 *
 * FAILS OPEN, ALWAYS. A typed meeting must never stall on a renderer fault, so
 * every failure path returns the planner's own next question instead. The
 * caller decides whether a fallback reply is worth persisting.
 *
 * @returns {{text, fallback, toolCalls, tokens, errorCode}}
 */
export async function renderLiveAssistantText({
  env,
  config,
  volatileStateItem = '',
  recentTurns = [],
  fallbackQuestion = '',
  dispatchTool
}) {
  const fallbackText = boundedAssistantText(fallbackQuestion)
    || 'Could you tell me a little more about that?';
  const instructions = buildLiveCataloguePrompt({
    directModulePlanning: config.modulePlannerMode === 'apply',
    channel: 'text'
  });
  const tools = liveToolsForConfig(config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENDERER_TIMEOUT_MS);
  const toolCalls = [];
  const tokens = { inputTextTokens: 0, cachedTextTokens: 0, outputTextTokens: 0 };

  try {
    const input = [];
    // The same short state note voice gets as a system conversation item. Text
    // rebuilds its input every turn, so it rides along rather than being
    // injected -- the content is byte-identical either way.
    if (volatileStateItem) input.push({ role: 'system', content: volatileStateItem });
    input.push(...transcriptInput(recentTurns));
    if (input.length === 0 || !input.some((item) => item.role === 'user')) {
      input.push({ role: 'user', content: 'Please begin the meeting.' });
    }

    let response = await callResponsesApi({
      env, config, instructions, tools, input, signal: controller.signal
    });
    addTokens(tokens, response?.usage);

    for (let pass = 1; pass < MAX_TOOL_PASSES; pass += 1) {
      const call = responseToolCall(response);
      if (!call) break;
      const output = await dispatchTool(call);
      toolCalls.push({ name: call.name, output });
      input.push({
        role: 'user',
        content: `The planning service completed ${call.name}. Result: `
          + `${JSON.stringify(output ?? {}).slice(0, 4_000)}. `
          + 'Reply to the client now. Do not call another tool.'
      });
      response = await callResponsesApi({
        env, config, instructions, tools, input, signal: controller.signal
      });
      addTokens(tokens, response?.usage);
    }

    const text = boundedAssistantText(responseText(response));
    return { text: text || fallbackText, fallback: !text, toolCalls, tokens };
  } catch (error) {
    return {
      text: fallbackText,
      fallback: true,
      toolCalls,
      tokens,
      errorCode: error instanceof ConsumerError ? error.code : 'live_text_renderer_failed'
    };
  } finally {
    clearTimeout(timer);
  }
}
