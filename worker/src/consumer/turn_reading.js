/**
 * An independent reading of one finalized client turn.
 *
 * WHY THIS EXISTS AT ALL
 *
 * The deterministic scan reads "two and a half thousand" as 2, and for a long
 * time that reading was authoritative — so a €2,500 monthly spend was refused
 * while a €2 monthly spend was accepted. Every attempt to repair that by
 * bounding the scan's own output failed, because a broken reading cannot anchor
 * a correct one.
 *
 * What replaces it is agreement between two readings that never saw each
 * other's answer. This module is the second of them.
 *
 * WHAT MAKES IT INDEPENDENT
 *
 * It is given the client's turn and the assistant question that prompted it,
 * and nothing else. No fact contracts, no existing notes, no canonical profile
 * facts, no Realtime proposals. It cannot agree with a candidate because it was
 * never shown one.
 *
 * It keeps the CONVERSATION, though, and that distinction is the whole point:
 * "hers is ninety" only means ninety thousand because of what came before it in
 * the same turn. Independence is about not seeing the other reader's answer,
 * not about reading in the dark.
 *
 * WHAT IT REFUSES TO DO
 *
 * Transcribing number words into digits is its job. Arithmetic is not: it never
 * totals, differences, or splits the difference on a range. Where the client
 * gave a range, or a figure whose scale is genuinely unclear, it says so rather
 * than choosing — an honest `ambiguous` costs one clarifying question, and a
 * guess costs a wrong number in someone's financial plan.
 */

import { CURRENCY_CODES } from '../../../js/planning/contracts.js';
import { ConsumerError } from './errors.js';

export const TURN_READING_PROMPT_VERSION = 'planeir-turn-reading-v1';

export const TURN_READING_SYSTEM_PROMPT = `You read ONE thing: the figures a client just stated out loud.

You are given the client's turn and the question they were answering. You are given nothing else — no records, no proposals, no expectations. Do not infer what figure would be useful, sensible, or expected. Report only what this client said.

For each figure the client stated, return:
- "digits": the figure in plain digits. Spoken numbers ARE figures and transcribing them is your job: "two and a half thousand" is 2500, "a hundred and eighty grand" is 180000, "about a hundred and eighty k" is 180000, "half a million" is 500000. A figure written in digits stays as it is.
- "quote": the exact, contiguous words from the client's turn that state that figure. Copy them verbatim; never rewrite or paraphrase.
- "currency": the currency the client named — EUR, GBP or USD. If they named none, use "unstated". A figure with no currency word is completely normal in speech.
- "ambiguous": true when you cannot honestly resolve the figure, false otherwise.

Read the whole turn together. A scale stated once carries across the sentence: in "mine is a hundred and eighty grand and hers is ninety", the second figure is 90000, not 90. Use the question the client was answering to understand what they are talking about, but never to invent a figure they did not give.

Mark "ambiguous": true, and put your best reading in "digits", when:
- the client gave a range or a choice — "about three or four", "between three and four thousand";
- the scale is genuinely unclear — "around one eighty" could be 180 or 180000;
- the client corrected themselves and you cannot tell which figure stands.

NEVER do arithmetic. Do not add figures together, subtract them, take a percentage of one, split the difference of a range, or convert a currency. If the client said "two thousand plus the other three", those are two figures, and 5000 is not one of them. A total the client did not say is not a figure they stated.

If the client stated no figures at all, return an empty list. That is a normal and correct answer.`;

const TURN_READING_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['figures'],
  properties: {
    figures: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['digits', 'quote', 'currency', 'ambiguous'],
        properties: {
          digits: { type: 'number' },
          quote: { type: 'string' },
          currency: { type: 'string', enum: [...CURRENCY_CODES, 'unstated'] },
          ambiguous: { type: 'boolean' }
        }
      }
    }
  }
});

/** How many figures one turn may contribute. A turn stating more than this is
 * not a turn anybody spoke; it is a parse gone wrong. */
const MAX_FIGURES_PER_TURN = 12;

/**
 * Normalize a model reading into the shape the agreement gate consumes.
 *
 * Exported for tests: the gate's behaviour has to be verifiable without paying
 * for a model call, and the normalizer is where a malformed reading becomes
 * either safe data or nothing at all.
 */
export function normalizeTurnReading(raw, { turnId, transcript = '' } = {}) {
  const figures = Array.isArray(raw?.figures) ? raw.figures : [];
  const text = String(transcript || '');
  const normalized = [];
  for (const figure of figures.slice(0, MAX_FIGURES_PER_TURN)) {
    const digits = Number(figure?.digits);
    if (!Number.isFinite(digits)) continue;
    const quote = String(figure?.quote || '').trim();
    // A quote that is not in the turn is not evidence from that turn. This is
    // the one structural check available here, and it costs nothing: the
    // reading may be wrong about what a figure MEANS, but it must not be able
    // to invent the words it came from.
    if (text && quote && !text.includes(quote)) continue;
    const currency = CURRENCY_CODES.includes(String(figure?.currency || ''))
      ? String(figure.currency)
      : null;
    normalized.push(Object.freeze({
      digits,
      quote,
      currency,
      ambiguous: figure?.ambiguous === true
    }));
  }
  return Object.freeze({ turnId: String(turnId || ''), figures: Object.freeze(normalized) });
}

/**
 * Read one client turn independently.
 *
 * Returns the normalized reading, or null when the provider could not be
 * reached. Null is not an error the caller should escalate: with no second
 * reading the gate simply falls back to the deterministic behaviour that
 * shipped before this existed, which is strictly no worse than today.
 */
export async function readClientTurnFigures({
  env,
  config,
  turnId,
  transcript,
  assistantQuestion = ''
}) {
  const text = String(transcript || '').trim();
  if (!text) return normalizeTurnReading(null, { turnId, transcript: text });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.turnReadingTimeoutMs);
  let response;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${String(env.OPENAI_API_KEY || '').trim()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.turnReadingModel,
        store: false,
        max_output_tokens: config.turnReadingMaxOutputTokens,
        reasoning: { effort: 'low' },
        input: [
          { role: 'system', content: TURN_READING_SYSTEM_PROMPT },
          {
            role: 'user',
            content: JSON.stringify({
              questionTheClientWasAnswering: String(assistantQuestion || '').slice(0, 2_000),
              clientTurn: text.slice(0, 4_000)
            })
          }
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'client_turn_figures_v1',
            strict: true,
            schema: TURN_READING_SCHEMA
          }
        }
      }),
      signal: controller.signal
    });
  } catch (_error) {
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) return null;

  let payload;
  try {
    payload = await response.json();
  } catch (_error) {
    return null;
  }
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const textPart = output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .find((part) => typeof part?.text === 'string');
  if (!textPart) return null;
  let parsed;
  try {
    parsed = JSON.parse(textPart.text);
  } catch (_error) {
    return null;
  }
  return normalizeTurnReading(parsed, { turnId, transcript: text });
}

/** Reject a misconfigured mode loudly rather than silently reading nothing. */
export function assertTurnReadingMode(mode) {
  if (['off', 'shadow', 'apply'].includes(mode)) return mode;
  throw new ConsumerError(
    500,
    'turn_reading_mode_invalid',
    'CONSUMER_TURN_READING_MODE must be off, shadow or apply.'
  );
}
