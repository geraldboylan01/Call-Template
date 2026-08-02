/**
 * OpenAI simulated client — an external model playing the consumer.
 *
 * THREE SEPARATE ROLES, THREE SEPARATE CONTEXTS.
 *
 *   1. This file — the simulated CLIENT. It is given a scenario identity and
 *      told to behave like that person. It receives ONLY the client-visible
 *      conversation. It never sees expected outcomes, module ids, goal codes,
 *      fact ids or any planning state, because it is playing the consumer and
 *      any of that would invalidate the test.
 *   2. Planéir under test — the real shared planning engine, unchanged.
 *   3. The judge (separate, later) — never shares a context with this.
 *
 * The client produces natural language ONLY. Extraction is still performed by
 * the real production planner, so this exercises the genuine path end to end:
 * an unscripted human-like utterance in, real PlannerExtractionV3 out.
 *
 * Paid. Never used by CI. Requires OPENAI_API_KEY.
 */

import { extractRealtimePlannerTurn } from '../../worker/src/consumer/realtime_planner.js';
import { callerBrief } from '../agent-harness/caller.mjs';

const CLIENT_SYSTEM_PROMPT = [
  'You are role-playing a member of the public talking to a financial planning service in Ireland.',
  'You are the CLIENT, not the adviser. Speak only as yourself, in first person, in natural spoken English.',
  'Reply with one to three sentences. Never use bullet points, headings or markdown.',
  'Answer the question you were just asked. Volunteer detail the way a real person does — sometimes more',
  'than asked, sometimes less — but never invent a figure you have not been given in your brief.',
  'If your brief does not contain something you are asked for, say you are not sure or give a rough sense.',
  'Never mention that you are simulated, never describe your brief, and never list your goals as a set.',
  'Reveal what matters to you gradually and naturally, as it comes up.',
  'Never use internal jargon such as module names, goal codes or fact identifiers.'
].join('\n');

function clientBrief(scenario) {
  const client = scenario.client || {};
  // A pasted caller is used VERBATIM. See scripts/agent-harness/caller.mjs:
  // structuring someone's own description of themselves would decide in advance
  // which details matter, and the dropped ones are the ones a call trips over.
  const caller = callerBrief(scenario);
  if (caller) return caller;
  const lines = [
    `You are: ${client.identity || 'a person seeking financial guidance'}.`,
    client.circumstances ? `Your circumstances: ${client.circumstances}` : '',
    client.knownFacts ? `Things you know about yourself: ${client.knownFacts}` : '',
    client.wants ? `What you are hoping to get out of this: ${client.wants}` : '',
    client.style ? `How you talk: ${client.style}` : '',
    (client.behaviours || []).length ? `Behave like this: ${client.behaviours.join('; ')}` : ''
  ].filter(Boolean);
  return lines.join('\n');
}

async function callResponses({ apiKey, model, instructions, input, maxTokens = 300 }) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Client-Request-Id': crypto.randomUUID()
    },
    body: JSON.stringify({
      model, store: false, instructions, input, max_output_tokens: maxTokens
    })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`simulated client request failed: ${response.status} ${detail.slice(0, 200)}`);
  }
  const payload = await response.json();
  const usage = {
    inputTokens: Number(payload?.usage?.input_tokens || 0),
    outputTokens: Number(payload?.usage?.output_tokens || 0),
    cachedInputTokens: Number(payload?.usage?.input_tokens_details?.cached_tokens || 0)
  };
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return { text: payload.output_text.trim(), usage };
  }
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') {
        return { text: content.text.trim(), usage };
      }
    }
  }
  throw new Error('simulated client returned no text');
}

/**
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} [options.model] the model PLAYING THE CLIENT — deliberately
 *   separate from the planner model, so a change to one cannot silently retune
 *   the other.
 * @param {number} [options.maxTurns]
 */
export function createOpenAiClient({ apiKey, model = 'gpt-5.6-luna', maxTurns = 12 } = {}) {
  if (!apiKey) throw new Error('createOpenAiClient requires an API key');
  return {
    id: 'openai',
    // Token counts are kept PER ROLE. The client and the planner are different
    // models on different price tiers, and a batch that totalled them together
    // could not tell you which half of the conversation costs the money.
    usage: {
      clientCalls: 0,
      plannerCalls: 0,
      client: { model, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      planner: { model: null, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      plannerLatenciesMs: []
    },

    async nextMessage({ scenario, transcript, turnIndex }) {
      if (turnIndex >= maxTurns) return null;
      // The client sees ONLY the client-visible conversation.
      const input = transcript.length === 0
        ? [{ role: 'user', content: 'The planner has just greeted you. Open the conversation.' }]
        : transcript.map((turn) => ({
            role: turn.role === 'client' ? 'assistant' : 'user',
            content: turn.text
          }));
      this.usage.clientCalls += 1;
      const { text, usage } = await callResponses({
        apiKey,
        model,
        instructions: `${CLIENT_SYSTEM_PROMPT}\n\nYour brief:\n${clientBrief(scenario)}`,
        input
      });
      this.usage.client.inputTokens += usage.inputTokens;
      this.usage.client.outputTokens += usage.outputTokens;
      this.usage.client.cachedInputTokens += usage.cachedInputTokens;
      return text;
    },

    /**
     * Extraction runs through the REAL production planner. That is the point:
     * the whole pipeline is under test, not a scripted stand-in.
     */
    async extractionFor({ sourceTurnId, text, context }) {
      this.usage.plannerCalls += 1;
      const planned = await extractRealtimePlannerTurn({
        env: { OPENAI_API_KEY: apiKey },
        config: context.config,
        context,
        sourceTurnId,
        transcript: text,
        recentTurns: []
      });
      const metadata = planned.metadata || {};
      this.usage.planner.model = metadata.model || this.usage.planner.model;
      this.usage.planner.inputTokens += Number(metadata.inputTokens || 0);
      this.usage.planner.outputTokens += Number(metadata.outputTokens || 0);
      this.usage.planner.cachedInputTokens += Number(metadata.cachedInputTokens || 0);
      if (Number.isFinite(metadata.latencyMs)) this.usage.plannerLatenciesMs.push(metadata.latencyMs);
      return planned.extraction;
    }
  };
}
