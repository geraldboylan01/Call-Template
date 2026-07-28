/**
 * Compliance for the live conversational lane.
 *
 * THE INVERSION THIS FILE EXISTS TO IMPLEMENT
 *
 * The v2 lane buys safety by restricting what the model may SAY: a client
 * question is resolved against a nine-entry dictionary
 * (`REALTIME_EDUCATION_V1`) and the model is instructed to "stay within that
 * reviewed answer". That is a positive allowlist of permitted answers, and it
 * is precisely why the meeting cannot hold a conversation — anything nobody
 * enumerated becomes "I only ask for facts used by the analyses shown on
 * screen".
 *
 * Here the model speaks freely and the SYSTEM is made unable to deliver
 * regulated advice. The boundary is a negative one — five prohibited ACTS,
 * independent of topic — enforced by layers that all sit BEHIND speech:
 *
 *   L1  the acts stated in the cached prompt (see catalogue_prompt.js)
 *   L2  deterministic numeric containment      — scanAssistantSpeech()
 *   L3  deterministic lead-in tripwire         — scanAssistantSpeech()
 *   L4  asynchronous per-turn supervisor       — reviewAssistantTurn()
 *   L5  escalation + audit                     — owned by live_session.js
 *
 * NOTHING IN THIS FILE MAY BE AWAITED BEFORE A RESPONSE IS CREATED. L2/L3 are
 * synchronous regex over a bounded string. L4 is an LLM call, but it is fired
 * without await and its result changes the NEXT turn, never the current one.
 * The v2 planner was the same API in the opposite position in the loop, and
 * that position was the entire latency bug.
 */

import { publicIrishStatePensionRule } from '../../../../js/planning/ireland_rules.js';

/**
 * The single shared vocabulary. The prompt (L1), the deterministic detectors
 * (L2/L3), the supervisor schema (L4) and the audit log all name acts from
 * this list, so a change here propagates to every layer at once.
 */
export const PROHIBITED_ACTS = Object.freeze([
  Object.freeze({
    id: 'recommendation',
    label: 'Recommending a product, provider, or course of action',
    correction: 'You just recommended a course of action, which you must never do. '
      + 'Correct it immediately and warmly: say plainly that you cannot recommend products or actions, '
      + 'say what you CAN do instead — capture the facts and prepare the analyses for adviser review — '
      + 'then continue the conversation naturally. Do not be apologetic or repetitive about it.'
  }),
  Object.freeze({
    id: 'eligibility',
    label: 'Deciding or asserting eligibility, approval, or entitlement',
    correction: 'You just made an eligibility, approval or entitlement claim, which you must never do. '
      + 'Correct it immediately: say you cannot decide eligibility or approval, that a lender or adviser owns that, '
      + 'and that what you can do is capture the relevant facts. Then continue naturally.'
  }),
  Object.freeze({
    id: 'unsourced_figure',
    label: 'Producing a figure, projection, comparison or calculation the deterministic engine did not return',
    correction: 'You just stated a financial figure that neither the client gave you nor the server supplied. '
      + 'Correct it immediately: withdraw the number plainly, say the figures come from the analyses on screen '
      + 'once they run, and continue. Never repeat the invented figure.'
  }),
  Object.freeze({
    id: 'time_sensitive_rule',
    label: 'Stating a time-sensitive rate, threshold or tax rule other than the server-supplied Irish State Pension rule',
    correction: 'You just stated a rate, threshold or tax rule that is not the server-supplied one. '
      + 'Correct it immediately: say you cannot rely on live or time-sensitive rules in this conversation '
      + 'and that an adviser confirms current figures. Then continue.'
  }),
  Object.freeze({
    id: 'premature_result',
    label: 'Claiming an analysis has run, or describing a result, before it has been confirmed and executed',
    correction: 'You described an analysis or a result that has not run yet. '
      + 'Correct it immediately: say nothing has been calculated yet, that the client reviews and confirms first, '
      + 'and then continue with what you still need.'
  })
]);

export const PROHIBITED_ACT_IDS = Object.freeze(PROHIBITED_ACTS.map((act) => act.id));

export function prohibitedAct(actId) {
  return PROHIBITED_ACTS.find((act) => act.id === actId) || null;
}

/* ------------------------------------------------------------------------ *
 * L2 — numeric containment
 *
 * The rule: THE MODEL MAY NOT VOICE A FINANCIAL FIGURE THAT NEITHER THE
 * CLIENT NOR THE SERVER PRODUCED.
 *
 * Note the client half. The model echoing what it just heard — "so you're
 * looking at around €420,000, got it" — is exactly the acknowledge-and-confirm
 * shape the conversation design asks for, so every figure in a finalized
 * client turn is sourced. Server-sourced figures are the State Pension rule,
 * saved fact values and deterministic module output.
 *
 * KNOWN LIMIT, DELIBERATE: this catches digit-form figures only. A figure
 * spoken as words ("four hundred thousand euro") is not parsed here — that is
 * L4's job, which reads the whole turn with a model. Deterministic where
 * deterministic works; LLM where it does not.
 * ------------------------------------------------------------------------ */

// Rounding tolerance. "about €300 a week" against a sourced €299.30 is a
// paraphrase of a sourced figure, not an invention. 1% is wide enough for
// natural rounding and far too narrow to launder a made-up number.
const FIGURE_TOLERANCE_RATIO = 0.01;

// A bare four-digit number in this range reads as a year, not money, unless it
// carries a currency marker.
const YEAR_LIKE_MINIMUM = 1900;
const YEAR_LIKE_MAXIMUM = 2100;

// Bare numbers below this are ages, counts, terms and step numbers. Money that
// small is not a compliance risk and flagging it would cancel good sentences.
const BARE_FIGURE_FLOOR = 1000;

const NUMBER = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;

// Every suffix that carries a word character is anchored with \b so a unit
// cannot be read out of an unrelated word — without it, "10 minutes" parses as
// "10 m" and becomes ten million.
const SUFFIX = String.raw`%|per\s*cent\b|percent\b|euros?\b|eur\b|k\b|grand\b|thousand\b|million\b|billion\b|bn\b|m\b`;

// Match every number, then classify. Matching only currency-marked numbers
// would miss a bare "420,000", which is the commonest way a model states a
// house price.
const FIGURE_PATTERN = new RegExp(
  String.raw`(€|EUR\b\s*)?\s*(${NUMBER})\s*(${SUFFIX})?`,
  'gi'
);

function magnitudeMultiplier(suffix) {
  const token = String(suffix || '').trim().toLowerCase();
  if (token === 'k' || token === 'grand' || token === 'thousand') return 1_000;
  if (token === 'm' || token === 'million') return 1_000_000;
  if (token === 'bn' || token === 'billion') return 1_000_000_000;
  return 1;
}

/**
 * Extract the financial figures from a piece of text as canonical numbers.
 * Returns numbers, not strings, so "€299.30", "299.3" and "EUR 299.30" all
 * collapse to the same value.
 */
export function extractFinancialFigures(value) {
  const text = String(value || '');
  if (!text) return [];
  const figures = [];
  for (const match of text.matchAll(FIGURE_PATTERN)) {
    const [, currencyPrefix, raw, suffix] = match;
    if (!raw) continue;
    const numeric = Number(String(raw).replace(/,/g, ''));
    if (!Number.isFinite(numeric)) continue;

    const token = String(suffix || '').trim().toLowerCase();
    const currencyMarked = Boolean(currencyPrefix) || /^euros?$|^eur$/.test(token);
    const percentMarked = /^%$|^per\s*cent$|^percent$/.test(token);
    const magnitude = magnitudeMultiplier(token);
    const scaled = numeric * magnitude;

    // A bare number that is neither currency- nor percent-marked has to clear
    // the floor to count as financial, and must not read as a year. This is
    // what keeps ages, counts, terms and dates out of the detector.
    if (!currencyMarked && !percentMarked && magnitude === 1) {
      if (scaled < BARE_FIGURE_FLOOR) continue;
      if (Number.isInteger(scaled) && scaled >= YEAR_LIKE_MINIMUM && scaled <= YEAR_LIKE_MAXIMUM) continue;
    }
    figures.push(scaled);
  }
  return figures;
}

/**
 * The per-session set of figures the model is allowed to voice. Kept as a
 * plain array of numbers behind a small API so the caller cannot accidentally
 * add strings of differing formats.
 */
export function createSourcedFigureSet() {
  const rule = publicIrishStatePensionRule();
  return {
    values: [
      rule.weeklyMaximumEur,
      rule.annualMaximumEur,
      rule.defaultStartAge,
      rule.defaultEscalationRate * 100
    ]
  };
}

/** Add every financial figure found in free text — a client turn, or tool output. */
export function addSourcedFiguresFromText(set, value) {
  if (!set || !Array.isArray(set.values)) return set;
  for (const figure of extractFinancialFigures(value)) set.values.push(figure);
  return set;
}

/** Add explicit numeric values — saved fact values, deterministic module output. */
export function addSourcedFigures(set, values) {
  if (!set || !Array.isArray(set.values)) return set;
  const walk = (node, depth = 0) => {
    if (depth > 6 || node === null || node === undefined) return;
    if (typeof node === 'number' && Number.isFinite(node)) { set.values.push(node); return; }
    if (typeof node === 'string') { addSourcedFiguresFromText(set, node); return; }
    if (Array.isArray(node)) { node.forEach((item) => walk(item, depth + 1)); return; }
    if (typeof node === 'object') { Object.values(node).forEach((item) => walk(item, depth + 1)); }
  };
  walk(values);
  return set;
}

function figureIsSourced(set, figure) {
  const values = Array.isArray(set?.values) ? set.values : [];
  return values.some((sourced) => {
    if (sourced === figure) return true;
    const scale = Math.max(Math.abs(sourced), Math.abs(figure));
    if (scale === 0) return true;
    return Math.abs(sourced - figure) / scale <= FIGURE_TOLERANCE_RATIO;
  });
}

/* ------------------------------------------------------------------------ *
 * L3 — lead-in tripwire
 *
 * Recommendation and eligibility claims announce themselves in their first few
 * words, so a streaming scan can cancel the response before the substantive
 * claim is voiced.
 *
 * PRECISION OVER RECALL. A false cancel cuts off a good sentence in front of a
 * customer, which is worse than a miss — L4 is the net behind this. Every
 * pattern below is either unambiguous on its own, or requires a financial
 * object nearby. The negative guards are as important as the patterns and are
 * asserted as first-class test cases.
 * ------------------------------------------------------------------------ */

// Unambiguous regardless of context.
const UNAMBIGUOUS_RECOMMENDATION = [
  /\bmy advice (?:is|would be)\b/i,
  /\bi'?d advise you\b/i,
  /\bi (?:would |'d )?recommend(?:ed)? that you\b/i,
  /\byour best (?:bet|option) (?:is|would be)\b/i,
  /\bthe best (?:option|product|provider|policy|fund|plan) (?:for you )?(?:is|would be)\b/i
];

// Recommendation verbs that only trip alongside a financial object.
const CONTEXTUAL_RECOMMENDATION = [
  /\bi (?:would |'d )?recommend\b/i,
  /\bi (?:would |'d )?suggest\b/i,
  /\byou (?:should|ought to|need to|'d be better off|would be better off)\b/i,
  /\bwhat i(?:'d| would) do\b/i
];

// Financial actions/objects that make a recommendation verb a real recommendation.
const FINANCIAL_OBJECT = new RegExp(
  String.raw`\b(?:pension|prsa|avc|mortgage|remortgage|loan|fund|funds|invest|investing|investment|`
  + String.raw`product|provider|policy|premium|annuity|arf|equit(?:y|ies)|share[s]?|stock[s]?|bond[s]?|`
  + String.raw`etf|crypto|bitcoin|deposit|savings account|switch|consolidat|overpay|top up|top-up|`
  + String.raw`lump sum|contribut|cover|protection|life insurance|income protection)\b`,
  'i'
);

// "you should be able to see that on screen" must never trip. These win.
const RECOMMENDATION_NEGATIVE_GUARDS = [
  /\byou should (?:be able to|see|hear|have|find|expect|notice|get a chance)\b/i,
  /\byou (?:should|need to) (?:tell me|let me know|say|shout|stop me|feel free)\b/i,
  /\bi(?:'d| would) suggest we\b/i,
  /\bi(?:'d| would) recommend we (?:come back|move on|park|start)\b/i,
  /\byou need to (?:know|understand|be aware)\b/i
];

const ELIGIBILITY_CLAIM = [
  /\byou(?:'d| would| will| 'll|'ll)? (?:definitely |likely |probably |certainly )?qualify\b/i,
  /\byou (?:are|'re|would be|'d be|will be) (?:definitely |likely |probably )?eligible\b/i,
  /\byou(?:'d| would| will|'ll)? (?:be )?approved\b/i,
  /\byou(?:'re| are| would be|'d be) entitled to\b/i,
  /\byou(?:'d| would)? get approved\b/i
];

const PREMATURE_RESULT = [
  /\b(?:i(?:'ve| have) (?:just )?(?:run|calculated|worked out)|the (?:analysis|projection|calculation) (?:shows|says|came back))\b/i,
  /\bbased on my calculation\b/i
];

/**
 * Declining to do a thing contains the words for doing it. "I am not able to
 * tell you whether you would qualify" is the CORRECT behaviour and must never
 * be flagged as an eligibility claim — so before any L3 pattern counts, the
 * text immediately preceding it is checked for a negation or an epistemic
 * hedge.
 *
 * This deliberately costs recall: "if that is right, you would qualify" is
 * suppressed too. L4 reads the whole turn and covers what this gives up.
 */
const NEGATION_LOOKBACK = 70;
const NEGATION_MARKER = /\b(?:not|cannot|can'?t|won'?t|unable|never|whether|if|neither|nor|don'?t|doesn'?t|isn'?t|aren'?t|wouldn'?t)\b/i;

function claimIsNegated(text, index) {
  const window = text.slice(Math.max(0, index - NEGATION_LOOKBACK), index);
  // Only the CURRENT clause can negate the claim. Without this, "you should
  // not leave it in cash, you should move it into a fund" would be suppressed
  // by a negation that belongs to the previous clause.
  const clause = window.split(/[.,;:—–?!]/).pop();
  return NEGATION_MARKER.test(clause);
}

function firstUnnegatedMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && !claimIsNegated(text, match.index)) return match;
  }
  return null;
}

/**
 * L2 + L3 in one synchronous pass over the assistant's speech so far.
 *
 * Call it on every transcript delta. It is regex over a bounded string and
 * must stay that way — anything expensive here lands directly on the audio
 * path this whole lane exists to protect.
 *
 * @returns {{tripped: boolean, actId: string|null, evidence: string, layer: string|null}}
 */
export function scanAssistantSpeech(text, sourcedFigures) {
  const speech = String(text || '').slice(0, 4_000);
  const clean = () => ({ tripped: false, actId: null, evidence: '', layer: null });
  if (!speech.trim()) return clean();

  // L3 first: it is cheaper and fires earliest in the sentence.
  const guarded = RECOMMENDATION_NEGATIVE_GUARDS.some((pattern) => pattern.test(speech));

  const unambiguous = firstUnnegatedMatch(speech, UNAMBIGUOUS_RECOMMENDATION);
  if (unambiguous) {
    return { tripped: true, actId: 'recommendation', evidence: unambiguous[0], layer: 'L3' };
  }
  if (!guarded && FINANCIAL_OBJECT.test(speech)) {
    const contextual = firstUnnegatedMatch(speech, CONTEXTUAL_RECOMMENDATION);
    if (contextual) {
      return { tripped: true, actId: 'recommendation', evidence: contextual[0], layer: 'L3' };
    }
  }
  const eligibility = firstUnnegatedMatch(speech, ELIGIBILITY_CLAIM);
  if (eligibility) {
    return { tripped: true, actId: 'eligibility', evidence: eligibility[0], layer: 'L3' };
  }
  const premature = firstUnnegatedMatch(speech, PREMATURE_RESULT);
  if (premature) {
    return { tripped: true, actId: 'premature_result', evidence: premature[0], layer: 'L3' };
  }

  // L2: any financial figure with no source.
  for (const figure of extractFinancialFigures(speech)) {
    if (!figureIsSourced(sourcedFigures, figure)) {
      return { tripped: true, actId: 'unsourced_figure', evidence: String(figure), layer: 'L2' };
    }
  }

  return clean();
}

/* ------------------------------------------------------------------------ *
 * L4 — asynchronous supervisor
 *
 * One cheap structured call per completed assistant turn, classifying it
 * against the five acts. FIRED WITHOUT AWAIT by the caller: it runs concurrent
 * with the client's next turn and its verdict changes the NEXT response.
 *
 * Any failure — timeout, outage, malformed output — resolves to "no violation
 * found". A supervisor that can stall or break a meeting would reproduce the
 * exact defect this lane was built to remove.
 * ------------------------------------------------------------------------ */

const SUPERVISOR_TIMEOUT_MS = 4_000;
const SUPERVISOR_MAX_OUTPUT_TOKENS = 160;
const SUPERVISOR_MAX_TRANSCRIPT = 1_200;

const SUPERVISOR_SYSTEM_PROMPT = [
  'You review one spoken turn from Planéir, a disclosed AI financial-education companion operating in Ireland.',
  'Planéir gathers facts and prepares deterministic analyses. It is NOT an adviser and must never do any of the following:',
  ...PROHIBITED_ACTS.map((act, index) => `${index + 1}. ${act.label} (id: ${act.id}).`),
  '',
  'Judge ONLY the assistant turn supplied. Judge what it actually did, not what it might imply.',
  'Explaining what an analysis will do, describing what information is needed and why, answering a general',
  'question about how something works, declining to advise, and repeating a figure the client themselves stated',
  'are all CORRECT behaviour and are NOT violations.',
  'Report a violation only when the turn genuinely commits one of the listed acts.',
  'Use confidence "high" only when the act is explicit and unmistakable.',
  'Return JSON only.'
].join('\n');

const SUPERVISOR_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['violation', 'actId', 'evidence', 'confidence'],
  properties: {
    violation: { type: 'boolean' },
    actId: { type: ['string', 'null'], enum: [...PROHIBITED_ACT_IDS, null] },
    evidence: { type: 'string', maxLength: 300 },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] }
  }
});

function supervisorOutputText(response) {
  const part = (Array.isArray(response?.output) ? response.output : [])
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .find((content) => content?.type === 'output_text' && typeof content.text === 'string');
  return part?.text || '';
}

const NO_VIOLATION = Object.freeze({
  violation: false, actId: null, evidence: '', confidence: 'low', latencyMs: 0, usage: null
});

/**
 * Review one completed assistant turn.
 *
 * Never throws. Never blocks. A failed review is indistinguishable from a
 * clean one to the caller, by design.
 */
export async function reviewAssistantTurn({
  env,
  config,
  assistantTranscript,
  clientTranscript = '',
  timeoutMs = SUPERVISOR_TIMEOUT_MS
} = {}) {
  const transcript = String(assistantTranscript || '').trim().slice(0, SUPERVISOR_MAX_TRANSCRIPT);
  if (!transcript) return NO_VIOLATION;

  const apiKey = String(env?.OPENAI_API_KEY || '').trim();
  if (!apiKey) return NO_VIOLATION;

  const model = String(config?.liveSupervisorModel || '').trim();
  if (!model) return NO_VIOLATION;

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || SUPERVISOR_TIMEOUT_MS));

  try {
    const apiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        store: false,
        reasoning: { effort: 'low' },
        max_output_tokens: SUPERVISOR_MAX_OUTPUT_TOKENS,
        input: [
          { role: 'system', content: SUPERVISOR_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Client said (context only, never judged): ${String(clientTranscript || '').slice(0, 400) || '(nothing)'}\n\nAssistant turn to review: ${transcript}`
          }
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'planeir_live_compliance_review_v1',
            strict: true,
            schema: SUPERVISOR_OUTPUT_SCHEMA
          }
        }
      }),
      signal: controller.signal
    });

    if (!apiResponse.ok) return NO_VIOLATION;

    const body = await apiResponse.json();
    let parsed;
    try {
      parsed = JSON.parse(supervisorOutputText(body));
    } catch (_error) {
      return NO_VIOLATION;
    }

    const actId = PROHIBITED_ACT_IDS.includes(parsed?.actId) ? parsed.actId : null;
    const confidence = ['low', 'medium', 'high'].includes(parsed?.confidence) ? parsed.confidence : 'low';

    // A low-confidence verdict is recorded by the caller but never acted on.
    // The deterministic layers already cover the unambiguous cases; this one
    // exists for what they cannot see, and it must not become a source of
    // spurious self-corrections.
    return {
      violation: parsed?.violation === true && Boolean(actId),
      actId,
      evidence: String(parsed?.evidence || '').slice(0, 300),
      confidence,
      latencyMs: Date.now() - startedAt,
      usage: body?.usage || null
    };
  } catch (_error) {
    return NO_VIOLATION;
  } finally {
    clearTimeout(timer);
  }
}

/** Should a supervisor verdict actually trigger a correction? */
export function supervisorVerdictIsActionable(verdict) {
  return Boolean(verdict?.violation) && verdict.confidence !== 'low';
}

/**
 * The instruction injected into the conversation so the model corrects itself
 * on its next turn. This is deliberately an instruction to speak naturally,
 * not a script to read: a stilted correction reads as a malfunction, while a
 * natural one reads as a careful adviser catching themselves.
 */
export function correctionInstruction(actId) {
  const act = prohibitedAct(actId);
  if (!act) return null;
  return `COMPLIANCE CORRECTION REQUIRED. ${act.correction}`;
}
