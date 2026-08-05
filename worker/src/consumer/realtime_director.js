import { ConsumerError } from './errors.js';

// The conversation director gives the live meeting a natural mouth without
// surrendering the steering wheel. The deterministic question plan remains
// the authority on WHAT must be asked next and every saved fact still flows
// through the versioned tool gates; the director is a bounded server-side
// text-model pass that decides only HOW the next authorized line is spoken —
// acknowledging what the consumer just said, answering meta-requests such as
// "repeat that", and steering back to the pending question. Any failure,
// timeout, or invalid output falls back to the deterministic template line,
// so the director can never break or stall a meeting.
const DIRECTOR_TIMEOUT_MS = 3_500;
const DIRECTOR_MAX_OUTPUT_TOKENS = 120;
const DIRECTOR_MAX_SPEECH_CHARACTERS = 380;
const DIRECTOR_MAX_TURNS = 6;
const DIRECTOR_MAX_TURN_CHARACTERS = 180;
const DIRECTED_SPEECH_KINDS = new Set(['question', 'acknowledgement', 'status']);

const DIRECTOR_SYSTEM_PROMPT = [
  'You are the speaking voice of Planéir, a clearly disclosed AI financial-education companion in a live voice meeting with one consumer in Ireland.',
  'You receive the deterministic interview state: the server-chosen pending question, the outcome of the planning action that just ran, the recent consumer turns, and your own previous spoken line. Compose the single next spoken line.',
  'Sound like a warm, unhurried human adviser-companion: one to three short sentences, at most fifty-five words, natural spoken English, no lists or headings.',
  'The server-chosen pending question is your goal. Deliver its intent naturally — briefly acknowledge what the consumer just shared when it helps, vary your phrasing, and never read the question robotically twice in a row.',
  'If the latest consumer turn is a meta-request — repeat that, what do you mean, slow down, who are you — answer it directly by restating your previous line or the pending question more plainly, and do not advance to anything new.',
  'If the consumer asked something outside the interview, acknowledge it in a clause and steer warmly back to the pending question.',
  'Never state or estimate figures the consumer did not say, never give advice, product recommendations, eligibility, calculations or projections; the on-screen analyses own every number.',
  'Never mention tools, servers, personas, errors, or internal state. Never ask for PPS numbers, account or card numbers, passwords, or an exact address.',
  'Return JSON only: {"speech":"..."} with the single spoken line.'
].join('\n');

const DIRECTOR_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['speech'],
  properties: {
    speech: { type: 'string', minLength: 1, maxLength: DIRECTOR_MAX_SPEECH_CHARACTERS }
  }
});

function boundedTurnLine(turn) {
  const role = turn?.role === 'user' ? 'Consumer' : 'Planéir';
  const text = String(turn?.transcript || '').replace(/\s+/g, ' ').trim().slice(0, DIRECTOR_MAX_TURN_CHARACTERS);
  return text ? `${role}: ${text}` : null;
}

function directedSpeechText(response) {
  const part = (Array.isArray(response?.output) ? response.output : [])
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .find((content) => content?.type === 'output_text' && typeof content.text === 'string');
  if (!part) return null;
  let parsed;
  try {
    parsed = JSON.parse(part.text);
  } catch (_error) {
    return null;
  }
  const speech = typeof parsed?.speech === 'string' ? parsed.speech.replace(/\s+/g, ' ').trim() : '';
  if (!speech
    || speech.length > DIRECTOR_MAX_SPEECH_CHARACTERS
    || /https?:\/\//i.test(speech)) {
    return null;
  }
  return speech;
}

export function directorUsageTokens(usage = {}) {
  const inputTokens = Number(usage?.input_tokens || 0);
  const cachedTokens = Number(usage?.input_tokens_details?.cached_tokens || 0);
  const outputTokens = Number(usage?.output_tokens || 0);
  const safe = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
  return {
    inputTextTokens: safe(inputTokens - cachedTokens),
    inputAudioTokens: 0,
    cachedTextTokens: safe(cachedTokens),
    cachedAudioTokens: 0,
    outputTextTokens: safe(outputTokens),
    outputAudioTokens: 0
  };
}

/**
 * Traced wrapper. The director fails OPEN — every failure path below returns
 * the deterministic template rather than raising — which is right for a call and
 * unreadable afterwards: a directed line and a silently fallen-back line look
 * identical once spoken. The span records which happened, and why.
 */
export async function composeDirectedSpeech(options) {
  const trace = options.trace || null;
  if (!trace?.active) return composeDirectedSpeechCall(options);

  const span = trace.startSpan();
  const result = await composeDirectedSpeechCall(options);
  trace.record({
    name: 'director',
    spanId: span.spanId,
    parentSpanId: options.traceParentSpanId,
    startedAt: span.startedAt,
    endedAt: Date.now(),
    model: options.config?.defaultModel,
    content: { input: options.templateText, output: result.text },
    usage: {
      inputTokens: result.tokens?.inputTextTokens,
      outputTokens: result.tokens?.outputTextTokens,
      cachedInputTokens: result.tokens?.cachedTextTokens
    },
    metadata: {
      // The distinction the span exists for.
      directed: result.directed,
      toolName: options.toolName,
      reasoningEffort: 'low'
    }
  });
  return result;
}

async function composeDirectedSpeechCall({
  env,
  config,
  kind,
  templateText,
  question,
  journeyPhase,
  toolName,
  toolOk,
  toolErrorCode,
  recentTurns,
  previousAssistantLine
}) {
  const fallback = { text: templateText, directed: false, responseId: null, tokens: null };
  try {
    if (config?.realtimeDirectorEnabled !== true
      || !DIRECTED_SPEECH_KINDS.has(String(kind || ''))
      || typeof templateText !== 'string'
      || !templateText) {
      return fallback;
    }
    const key = typeof env.OPENAI_API_KEY === 'string' ? env.OPENAI_API_KEY.trim() : '';
    if (!key) return fallback;

    const turnLines = (Array.isArray(recentTurns) ? recentTurns : [])
      .slice(-DIRECTOR_MAX_TURNS)
      .map(boundedTurnLine)
      .filter(Boolean);
    const contextLines = [
      `Interview phase: ${String(journeyPhase || 'discovery').slice(0, 40)}`,
      `Pending server question (your goal): ${String(question || templateText).slice(0, 400)}`,
      `Planning action just completed: ${String(toolName || 'none').slice(0, 60)} — ${toolOk === false ? `rejected (${String(toolErrorCode || 'unknown').slice(0, 80)})` : 'succeeded'}`,
      `Deterministic template line (your safe fallback and meaning anchor): ${templateText.slice(0, 400)}`,
      previousAssistantLine
        ? `Your previous spoken line: ${String(previousAssistantLine).slice(0, 300)}`
        : 'Your previous spoken line: (none)',
      'Recent turns:',
      ...(turnLines.length ? turnLines : ['(none)'])
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DIRECTOR_TIMEOUT_MS);
    let response;
    try {
      const apiResponse = await fetch('https://api.openai.com/v1/responses', {
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
          max_output_tokens: DIRECTOR_MAX_OUTPUT_TOKENS,
          input: [
            { role: 'system', content: DIRECTOR_SYSTEM_PROMPT },
            { role: 'user', content: contextLines.join('\n') }
          ],
          text: {
            format: {
              type: 'json_schema',
              name: 'realtime_directed_speech_v1',
              strict: true,
              schema: DIRECTOR_OUTPUT_SCHEMA
            }
          }
        }),
        signal: controller.signal
      });
      if (!apiResponse.ok) {
        apiResponse.body?.cancel?.().catch?.(() => {});
        return fallback;
      }
      response = await apiResponse.json();
    } finally {
      clearTimeout(timeout);
    }

    const speech = directedSpeechText(response);
    if (!speech) return fallback;
    return {
      text: speech,
      directed: true,
      responseId: /^[A-Za-z0-9._:-]{1,160}$/.test(String(response?.id || ''))
        ? String(response.id)
        : `director_${crypto.randomUUID()}`,
      tokens: directorUsageTokens(response?.usage)
    };
  } catch (error) {
    if (error instanceof ConsumerError) return fallback;
    return fallback;
  }
}
