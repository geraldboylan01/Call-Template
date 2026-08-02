/**
 * A7 — the post-call reviewer.
 *
 * "What worked, what didn't, and what to change."
 *
 * This is the second opinion on top of the deterministic detectors in
 * agent-harness/blockers.mjs. The detectors find mechanical failures -- the
 * repeated question, the lost goal. The reviewer reads the actual words and
 * finds the things no detector can: a question that was technically new but
 * landed as a repeat, an explanation that did not explain, a moment where the
 * client volunteered something important and the meeting walked past it.
 *
 * ADVISORY, LIKE EVERY MODEL OPINION IN THIS HARNESS. It cannot fail a run. It
 * proposes; you and the deterministic findings dispose. Its value is that it
 * writes up a call in terms you can act on, not that it decides anything.
 *
 * It is given the deterministic findings, because a reviewer that rediscovers
 * "asked the same question three times" is wasting a call, and one that
 * CONTRADICTS a detector is telling you something useful about itself.
 */

const REVIEW_SYSTEM_PROMPT = [
  'You are reviewing a transcript of a financial planning conversation in Ireland.',
  'The planner is an AI meeting; the client is a member of the public.',
  'You are an experienced adviser asked what to change about the meeting, not about the client.',
  '',
  'You will be given the transcript and a list of mechanical problems already found automatically.',
  'Do not simply repeat those. Use them as context and find what they cannot see: questions that',
  'landed badly, explanations that did not explain, moments the meeting walked past something the',
  'client clearly cared about, jargon, false reassurance, or a pace that did not suit this person.',
  '',
  'Be concrete. "Ask about the pension earlier" is useful; "improve the conversation" is not.',
  'If the call went well, say so plainly and briefly rather than inventing faults.',
  '',
  'Reply with JSON only, no prose:',
  '{"worked":["..."],"did_not_work":[{"what":"...","turn":n,"why":"...","change":"..."}],',
  ' "biggest_single_change":"...","would_a_person_come_back":true}'
].join('\n');

function reviewInput(run, findings) {
  const transcript = (run.transcript || [])
    .map((entry, index) => `[${Math.floor(index / 2) + 1}] ${entry.role === 'client' ? 'CLIENT' : 'PLANNER'}: ${entry.text}`)
    .join('\n');
  const mechanical = findings.length
    ? findings.map((finding) => `- (${finding.severity}) turn ${finding.turn}: ${finding.detail}`).join('\n')
    : '- none found automatically';
  return `TRANSCRIPT\n${transcript}\n\nMECHANICAL PROBLEMS ALREADY FOUND\n${mechanical}`;
}

export function normaliseReview(raw) {
  const list = (value) => (Array.isArray(value) ? value : []).slice(0, 12);
  return {
    worked: list(raw?.worked).filter((item) => typeof item === 'string').map((item) => item.slice(0, 300)),
    didNotWork: list(raw?.did_not_work)
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        what: String(item.what || '').slice(0, 300),
        turn: Number.isFinite(Number(item.turn)) ? Number(item.turn) : null,
        why: String(item.why || '').slice(0, 300),
        change: String(item.change || '').slice(0, 300)
      }))
      .filter((item) => item.what),
    biggestSingleChange: String(raw?.biggest_single_change || '').slice(0, 400),
    wouldComeBack: typeof raw?.would_a_person_come_back === 'boolean' ? raw.would_a_person_come_back : null,
    available: true
  };
}

const UNAVAILABLE = Object.freeze({
  worked: [], didNotWork: [], biggestSingleChange: '', wouldComeBack: null, available: false
});

export function createOpenAiReviewer({ apiKey, model = 'gpt-5.6-terra' } = {}) {
  if (!apiKey) throw new Error('createOpenAiReviewer requires an API key');
  return {
    id: 'openai-reviewer',
    model,
    usage: { calls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },

    async review(run, findings) {
      this.usage.calls += 1;
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
          instructions: REVIEW_SYSTEM_PROMPT,
          input: [{ role: 'user', content: reviewInput(run, findings) }],
          max_output_tokens: 1_200
        })
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`reviewer request failed: ${response.status} ${detail.slice(0, 200)}`);
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

/** NEVER THROWS. An unavailable review is an absent opinion, not a failure. */
export async function reviewCall(reviewer, run, findings = []) {
  if (!reviewer) return { ...UNAVAILABLE };
  try {
    return normaliseReview(await reviewer.review(run, findings));
  } catch (error) {
    return { ...UNAVAILABLE, biggestSingleChange: `review unavailable: ${String(error?.message || error).slice(0, 200)}` };
  }
}

/**
 * Roll several reviews into the themes worth acting on.
 *
 * A change suggested once is an observation; the same change suggested across
 * several calls is a priority. Ranking by recurrence is what turns a pile of
 * reviews into a work list.
 */
export function aggregateReviews(reviews) {
  const available = reviews.filter((review) => review?.available);
  const counted = new Map();
  for (const review of available) {
    for (const item of review.didNotWork) {
      const key = item.change || item.what;
      const existing = counted.get(key) || { change: key, calls: 0, examples: [] };
      existing.calls += 1;
      if (existing.examples.length < 3) existing.examples.push(item.what);
      counted.set(key, existing);
    }
  }
  return {
    reviewed: available.length,
    wouldComeBack: available.filter((review) => review.wouldComeBack === true).length,
    recurringChanges: [...counted.values()].sort((left, right) => right.calls - left.calls).slice(0, 10),
    worked: [...new Set(available.flatMap((review) => review.worked))].slice(0, 10)
  };
}
