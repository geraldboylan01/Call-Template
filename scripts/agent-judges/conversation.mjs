/**
 * A6 — the advisory conversation judge.
 *
 * THE JUDGE NEVER FAILS A BUILD.
 *
 * That is a design decision, not an oversight. A model's opinion of a
 * conversation is useful for noticing drift in tone or in how well the meeting
 * explains itself, and useless as a gate: it is non-deterministic, it costs
 * money, and a regression it "detects" cannot be reproduced. Every hard
 * guarantee in this harness is a deterministic assertion in
 * run-consumer-agent-scenarios.mjs; the judge only ever adds scores to a report.
 *
 * The separation is structural, not a matter of care:
 *   - `judgeConversation` returns scores and never throws for a low score.
 *   - Callers treat its result as report data. `check-consumer-agent-batch.mjs`
 *     proves that a judge returning the worst possible scores, or throwing
 *     outright, leaves the batch exit code unchanged.
 *
 * ROLE SEPARATION. The judge is the third role in the harness and shares a
 * context with neither of the others. It sees the transcript and the questions
 * the meeting asked. It does NOT see the scenario's expected outcomes, so it
 * cannot mark against an answer key, and it does not see the simulated client's
 * brief, so it cannot reward the meeting for extracting facts it was told to
 * look for. It judges the conversation as a person would experience it.
 */

const JUDGE_SYSTEM_PROMPT = [
  'You are reviewing a transcript of a financial planning conversation in Ireland,',
  'as an experienced adviser would review a junior colleague\'s meeting.',
  'You are judging how the conversation felt and whether it earned the client\'s trust.',
  'You are NOT judging whether it reached any particular outcome, and you have not been told what it should have reached.',
  '',
  'Score each dimension from 1 (poor) to 5 (excellent):',
  '  tone         — warm, plain-spoken, never patronising, never salesy, no jargon.',
  '  groundedness — every claim traceable to what the client actually said; no invented figures, no promises about results.',
  '  explains_why — when it asks for something, the client can tell why it is being asked.',
  '  momentum     — the conversation goes somewhere; it does not loop, stall, or re-ask what was answered.',
  '',
  'Reply with JSON only, no prose:',
  '{"tone":n,"groundedness":n,"explains_why":n,"momentum":n,"note":"one sentence on the weakest dimension"}'
].join('\n');

export const JUDGE_DIMENSIONS = Object.freeze(['tone', 'groundedness', 'explains_why', 'momentum']);

function clampScore(value) {
  // An ABSENT score is not a low score. `Number(null)` and `Number('')` are both
  // 0, which would clamp to 1 and quietly report a judge that said nothing as a
  // judge that said "poor" -- the one way an advisory signal could look like a
  // real finding.
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.min(5, Math.max(1, Math.round(numeric)));
}

/**
 * Normalise whatever the judge returned into a shape the report can rely on.
 * Anything unparseable becomes null scores — an absent opinion, never a failure.
 */
export function normaliseJudgement(raw) {
  const scores = {};
  for (const dimension of JUDGE_DIMENSIONS) {
    scores[dimension] = clampScore(raw?.[dimension]);
  }
  const scored = JUDGE_DIMENSIONS.map((key) => scores[key]).filter((value) => value !== null);
  return {
    ...scores,
    mean: scored.length ? scored.reduce((sum, value) => sum + value, 0) / scored.length : null,
    note: typeof raw?.note === 'string' ? raw.note.slice(0, 300) : '',
    available: scored.length > 0
  };
}

function transcriptForJudge(run) {
  return (run.transcript || [])
    .map((entry) => `${entry.role === 'client' ? 'CLIENT' : 'PLANNER'}: ${entry.text}`)
    .join('\n');
}

/**
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} [options.model] the model JUDGING — deliberately separate from
 *   both the planner and the simulated client, so one model cannot mark its own
 *   homework.
 */
export function createOpenAiJudge({ apiKey, model = 'gpt-5.6-terra' } = {}) {
  if (!apiKey) throw new Error('createOpenAiJudge requires an API key');
  return {
    id: 'openai-judge',
    model,
    usage: { judgeCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },

    async judge(run) {
      this.usage.judgeCalls += 1;
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-Client-Request-Id': crypto.randomUUID()
        },
        body: JSON.stringify({
          model,
          store: false,
          instructions: JUDGE_SYSTEM_PROMPT,
          input: [{ role: 'user', content: transcriptForJudge(run) }],
          max_output_tokens: 400
        })
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`judge request failed: ${response.status} ${detail.slice(0, 200)}`);
      }
      const payload = await response.json();
      const usage = payload?.usage || {};
      this.usage.inputTokens += Number(usage.input_tokens || 0);
      this.usage.outputTokens += Number(usage.output_tokens || 0);
      this.usage.cachedInputTokens += Number(usage.input_tokens_details?.cached_tokens || 0);
      const text = typeof payload.output_text === 'string' && payload.output_text.trim()
        ? payload.output_text.trim()
        : (payload.output || [])
          .flatMap((item) => item.content || [])
          .find((content) => content?.type === 'output_text')?.text?.trim() || '';
      const match = text.match(/\{[\s\S]*\}/);
      return JSON.parse(match ? match[0] : text);
    }
  };
}

/**
 * Run the judge over one conversation.
 *
 * NEVER THROWS and never signals failure. A judge that errors, times out or
 * returns nonsense yields an unavailable judgement, because the alternative --
 * an advisory opinion breaking a run -- is exactly what this file exists to
 * prevent.
 */
export async function judgeConversation(judge, run) {
  if (!judge) return normaliseJudgement(null);
  try {
    return normaliseJudgement(await judge.judge(run));
  } catch (error) {
    return {
      ...normaliseJudgement(null),
      note: `judge unavailable: ${String(error?.message || error).slice(0, 200)}`
    };
  }
}

/** Mean score per dimension across a batch, for the trend line. */
export function aggregateJudgements(judgements) {
  const available = judgements.filter((item) => item?.available);
  const summary = { conversationsJudged: available.length };
  for (const dimension of JUDGE_DIMENSIONS) {
    const values = available.map((item) => item[dimension]).filter((value) => value !== null);
    summary[dimension] = values.length
      ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2))
      : null;
  }
  return summary;
}
