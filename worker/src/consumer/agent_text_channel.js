/**
 * The text transport's mouth.
 *
 * This is the ONLY genuinely new prompt-facing component in the agent journey,
 * and it is deliberately not a new prompt pack:
 *
 *   - instructions come from `buildRealtimeConversationV2Instructions` — the
 *     exact string the live voice meeting is given;
 *   - tools come from `realtimeToolsForState` — the exact list, with the exact
 *     state gating, so `record_module_decision` appears only while an offer is
 *     live and `resolve_capacity_decision` only while a capacity decision is;
 *   - tool calls are dispatched to the SAME shared handlers voice uses.
 *
 * If this file ever grows its own instruction text or its own tool definitions,
 * the one-engine guarantee is gone. `check-consumer-agent-api.mjs` asserts it
 * does not.
 *
 * Everything voice-specific is absent: no audio, no VAD, no barge-in, and
 * `wait_for_user` is filtered out because a text turn always needs a reply.
 */

import { ConsumerError } from './errors.js';
import {
  buildRealtimeConversationV2Instructions,
  realtimeToolsForState
} from './realtime_provider.js';
import { intakeExplanation } from './realtime_planner.js';
import { resolveCapacityDecision, resolveModuleOffer } from './planning_turn.js';

const RENDERER_TIMEOUT_MS = 12_000;
const RENDERER_MAX_OUTPUT_TOKENS = 400;
const MAX_ASSISTANT_CHARACTERS = 1_200;
const MAX_TRANSCRIPT_TURNS = 12;
const MAX_TRANSCRIPT_TURN_CHARACTERS = 400;

/** Tools that make no sense without audio. */
const VOICE_ONLY_TOOLS = new Set(['wait_for_user']);

export function agentToolsForState(state) {
  return realtimeToolsForState(state).filter((tool) => !VOICE_ONLY_TOOLS.has(tool.name));
}

function transcriptLines(turns) {
  return (Array.isArray(turns) ? turns : [])
    .slice(-MAX_TRANSCRIPT_TURNS)
    .map((turn) => {
      const role = turn?.role === 'user' ? 'Client' : 'Planéir';
      const text = String(turn?.transcript || '').replace(/\s+/g, ' ').trim()
        .slice(0, MAX_TRANSCRIPT_TURN_CHARACTERS);
      return text ? `${role}: ${text}` : null;
    })
    .filter(Boolean);
}

function boundedAssistantText(value) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!text || text.length > MAX_ASSISTANT_CHARACTERS) return '';
  if (/https?:\/\//i.test(text)) return '';
  return text;
}

function usageMicroEur(usage, config) {
  // Text-only spend, priced from the same realtime text rates the voice meeting
  // already meters with, so one euro figure means the same thing on both.
  const rates = config.realtimeUsageRates || {};
  const input = Math.max(0, Number(usage?.input_tokens || 0) - Number(usage?.input_tokens_details?.cached_tokens || 0));
  const cached = Number(usage?.input_tokens_details?.cached_tokens || 0);
  const output = Number(usage?.output_tokens || 0);
  const micros = (input * Number(rates.textInput || 0)
    + cached * Number(rates.textCachedInput || 0)
    + output * Number(rates.textOutput || 0)) / 1_000_000;
  return Number.isFinite(micros) ? Math.ceil(micros) : 0;
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

function responseToolCalls(response) {
  return (Array.isArray(response?.output) ? response.output : [])
    .filter((item) => item?.type === 'function_call' && typeof item.name === 'string')
    .map((item) => {
      let args = {};
      try {
        args = item.arguments ? JSON.parse(item.arguments) : {};
      } catch (_error) {
        args = {};
      }
      return { name: item.name, args, callId: item.call_id || item.id || null };
    });
}

async function callResponsesApi({
  env, config, instructions, tools, input, signal, trace = null, spanName = 'renderer'
}) {
  const key = typeof env.OPENAI_API_KEY === 'string' ? env.OPENAI_API_KEY.trim() : '';
  if (!key) throw new ConsumerError(503, 'agent_renderer_unconfigured', 'The text renderer is not configured.');
  const span = trace?.active ? trace.startSpan() : null;
  const record = (payload, errorCode = null) => trace?.record?.({
    name: spanName,
    spanId: span?.spanId,
    startedAt: span?.startedAt,
    endedAt: Date.now(),
    model: config.defaultModel,
    errorCode,
    content: { input, output: payload?.output_text ?? payload ?? null },
    usage: {
      inputTokens: Number(payload?.usage?.input_tokens || 0),
      outputTokens: Number(payload?.usage?.output_tokens || 0),
      cachedInputTokens: Number(payload?.usage?.input_tokens_details?.cached_tokens || 0)
    },
    metadata: {
      reasoningEffort: 'low',
      responseStatus: typeof payload?.status === 'string' ? payload.status : undefined,
      errorCode
    }
  });

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
    record(null, 'agent_renderer_failed');
    throw new ConsumerError(502, 'agent_renderer_failed', 'The text renderer could not produce a reply.');
  }
  const payload = await response.json();
  record(payload);
  return payload;
}

/**
 * Dispatch one model tool call to the SHARED handler. The text channel adds no
 * behaviour of its own here — this is the same code path the Durable Object's
 * executeTool uses.
 */
async function dispatchToolCall({ env, config, context, call }) {
  if (call.name === 'record_module_decision') {
    return resolveModuleOffer({
      env,
      config,
      context,
      decision: String(call.args?.decision || ''),
      activeOffer: context.state.meetingBrief?.moduleOffer || null
    });
  }
  if (call.name === 'resolve_capacity_decision') {
    return resolveCapacityDecision({
      env,
      config,
      context,
      decision: String(call.args?.decision || ''),
      replaceChoiceIndex: call.args?.replaceChoiceIndex,
      capacity: context.state.meetingBrief?.capacityDecision || null
    });
  }
  if (call.name === 'get_intake_explanation') {
    const clientIntent = context.state.meetingBrief?.clientQuestion?.intent || 'none';
    const topic = clientIntent === 'recommendation'
      ? 'recommendation_boundary'
      : clientIntent === 'eligibility'
        ? 'eligibility_boundary'
        : clientIntent === 'regulated_or_time_sensitive'
          ? 'adviser_boundary'
          : String(call.args?.topic || '').slice(0, 160);
    return {
      ok: true,
      topic,
      explanation: intakeExplanation(topic, context.state.meetingBrief)
    };
  }
  if (call.name === 'get_meeting_brief') {
    return {
      ok: true,
      meetingBrief: context.state.meetingBrief,
      conversationGuide: context.state.conversationGuide
    };
  }
  // Anything else (including confirm_and_run_voice_plan) is not reachable from
  // the text transport: confirmation is an explicit endpoint, not a model call.
  throw new ConsumerError(409, 'agent_tool_not_available', 'That planning action is not available on the text channel.');
}

/**
 * Produce the assistant's next message for a text meeting.
 *
 * Fails open to the deterministic server-owned question: a text meeting must
 * never stall because the renderer failed.
 *
 * @returns {{text, toolCalls, decisions, usageMicroEur, fallback}}
 */
export async function renderAssistantText({
  env,
  config,
  context,
  recentTurns = [],
  reloadContext,
  // What the silent planner managed to record from the turn being answered.
  // Without it the renderer confirms figures it does not hold and re-asks the
  // question it just asked. See extractionOutcomeInstructions.
  extractionOutcome = null,
  trace = null
}) {
  const state = context.state;
  const fallbackText = state.meetingBrief?.questionBatch?.prompt
    || state.nextQuestion?.prompt
    || 'Could you tell me a little more about that?';
  const tools = agentToolsForState(state);
  const instructions = buildRealtimeConversationV2Instructions(state, [], extractionOutcome);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENDERER_TIMEOUT_MS);
  const decisions = [];
  let spend = 0;
  let workingContext = context;

  try {
    const input = [
      ...transcriptLines(recentTurns).map((line) => ({
        role: line.startsWith('Client:') ? 'user' : 'assistant',
        content: line.replace(/^(?:Client|Planéir): /, '')
      }))
    ];
    if (input.length === 0) {
      input.push({ role: 'user', content: 'Please begin the meeting.' });
    }

    let response = await callResponsesApi({
      env, config, instructions, tools, input, signal: controller.signal, trace, spanName: 'renderer.call_1'
    });
    spend += usageMicroEur(response?.usage, config);

    const calls = responseToolCalls(response);
    if (calls.length > 0) {
      const call = calls[0];
      let output;
      // The tool sits between the two model calls and is the reason there are
      // two. A tree that skipped it would show a second call with no cause.
      const toolSpan = trace?.active ? trace.startSpan() : null;
      try {
        output = await dispatchToolCall({ env, config, context: workingContext, call });
      } catch (error) {
        output = {
          ok: false,
          code: error instanceof ConsumerError ? error.code : 'agent_tool_failed',
          message: error instanceof ConsumerError ? error.message : 'That action could not be completed.'
        };
      }
      decisions.push({ tool: call.name, args: call.args, result: output });
      trace?.record?.({
        name: `tool.${call.name}`,
        spanId: toolSpan?.spanId,
        startedAt: toolSpan?.startedAt,
        endedAt: Date.now(),
        observationType: 'span',
        content: { input: call.args, output },
        errorCode: output?.ok === false ? (output.code || 'agent_tool_failed') : null,
        metadata: { toolName: call.name, refused: output?.ok === false }
      });

      // A decision changes planning state, so the second pass must speak from
      // the refreshed brief rather than the one that produced the call.
      if (output?.ok && typeof reloadContext === 'function') {
        workingContext = await reloadContext();
      }
      const secondPassInstructions = buildRealtimeConversationV2Instructions(workingContext.state);
      response = await callResponsesApi({
        env,
        config,
        instructions: secondPassInstructions,
        tools: agentToolsForState(workingContext.state),
        input: [
          ...input,
          {
            role: 'user',
            content: `The planning service completed ${call.name}. Result: ${JSON.stringify(output).slice(0, 1_500)}. `
              + 'Reply to the client now in one to three natural sentences. Do not call another tool.'
          }
        ],
        signal: controller.signal,
        trace,
        spanName: 'renderer.call_2'
      });
      spend += usageMicroEur(response?.usage, config);
    }

    const text = boundedAssistantText(responseText(response));
    return {
      text: text || fallbackText,
      fallback: !text,
      decisions,
      usageMicroEur: spend,
      context: workingContext
    };
  } catch (error) {
    return {
      text: fallbackText,
      fallback: true,
      decisions,
      usageMicroEur: spend,
      context: workingContext,
      errorCode: error instanceof ConsumerError ? error.code : 'agent_renderer_failed'
    };
  } finally {
    clearTimeout(timer);
  }
}
