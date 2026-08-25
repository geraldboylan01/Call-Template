/**
 * Deterministic inventory of explicit value-bearing evidence in one finalized
 * client turn.
 *
 * This module deliberately knows nothing about pensions, shares, salaries or
 * any other category pairing. Its unit of work is an occurrence in the source
 * text, identified by offsets. Classification belongs to the planner and
 * acceptance belongs to the existing fact/reconciliation validators.
 */

const CURRENCY_BY_TOKEN = Object.freeze({
  '€': 'EUR', eur: 'EUR', euro: 'EUR', euros: 'EUR',
  '£': 'GBP', gbp: 'GBP', pound: 'GBP', pounds: 'GBP', sterling: 'GBP',
  '$': 'USD', usd: 'USD', dollar: 'USD', dollars: 'USD'
});

const NUMBER_WORD_VALUES = Object.freeze({
  zero: 0, one: 1, two: 2, both: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90
});

const NUMBER_WORD_SCALES = Object.freeze({
  hundred: 100,
  thousand: 1_000,
  million: 1_000_000,
  billion: 1_000_000_000
});

const CURRENCY_TOKEN_SOURCE = '€|£|\\$|EUR|GBP|USD|euros?|pounds?|sterling|dollars?';
const DIGIT_VALUE = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:(${CURRENCY_TOKEN_SOURCE})\\s*)?`
    + '(-?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?)'
    + '(?:\\s*(k|grand|thousand|m|million|bn|billion))?'
    + `(?:\\s*(${CURRENCY_TOKEN_SOURCE}))?`
    + '(?:\\s*(%|percent|per\\s+cent))?(?![\\p{L}\\p{N}_])',
  'giu'
);
// Deliberately narrower than a general correction-word search. A cue between
// two figures does not prove that the second replaces the first: "home €400k.
// Sorry, the mortgage is €200k" contains a perfectly valid apology and two
// independent facts. Only a same-clause bridge with no newly named subject is
// safe to classify before the planner/reconciler sees the words.
const DIRECT_CORRECTION_BRIDGE = /^[\s,;:—–-]*(?:sorry|actually|correction|i mean|make that|no(?:\s*,?\s*i mean)?)[\s,;:—–-]*(?:it|that|the\s+(?:figure|amount|balance|value))\s+(?:is|was|should\s+be|comes?\s+to)\s*$/i;

const IDENTIFIER_BEFORE = [
  /\b(?:account|policy|card|customer|member|employee|claim|application)\s+(?:number|no\.?|id|identifier|code|reference)\s*(?:is|was|:|#)?\s*$/iu,
  /\b(?:account|policy|card)\s+(?:ends?|ending)\s+(?:in|with)?\s*$/iu,
  /\b(?:phone|mobile|telephone|postcode|eircode|iban|bic|pin|reference|ref|identifier)\s*(?:number|no\.?|id|code)?\s*(?:is|was|:|#)?\s*$/iu,
  /\b(?:call|phone|ring|text)(?:\s+me)?\s+(?:at|on)?\s*$/iu,
  // A bare product/index number is much more likely to identify the item than
  // value it. "Fund is 500" is not caught because the linking verb remains.
  /\b(?:holding|fund|account|policy|plan|scheme|item|option)\s*(?:number|no\.?|#)?\s*$/iu
];
const NON_VALUE_COUNT_AFTER = /^\s*(?:people|persons?|employees?|clients?|customers?|members?|attendees?|votes?|responses?|items?|units?|children|years?\s+old)\b/iu;
const DIRECT_FINANCIAL_SUBJECT_BEFORE = /\b(?:rent|repayments?|payments?|salary|wages?|income|bonus|cash|savings?|balance|mortgage|loans?|debts?|childcare|insurance|premium|bills?|costs?|expenses?|spending|contributions?|budget)\s*$/iu;
const LINKED_FINANCIAL_SUBJECT_BEFORE = /\b(?:rent|repayments?|payments?|salary|wages?|income|bonus|cash|savings?|balance|mortgage|loans?|debts?|pensions?|funds?|shares?|investments?|property|house|home|business|childcare|insurance|premium|bills?|costs?|expenses?|spending|contributions?|budget)\b[^.!?;\n]{0,48}\b(?:is|was|are|were|at|of|about|around|roughly|approximately|worth|valued\s+at|comes?\s+to|totals?|costs?)\s*$/iu;
const FINANCIAL_ACTION_BEFORE = /\b(?:pay|paying|repay|repaying|spend|spending|earn|earning|make|making|receive|receiving|save|saving|owe|owing|costs?|worth|valued\s+at)\s+(?:about|around|roughly|approximately|nearly|just)?\s*$/iu;
const FINANCIAL_OBJECT_AFTER = /^\s+(?:in|of|on|for|towards?)\s+(?:cash|savings?|rent|a\s+mortgage|the\s+mortgage|a\s+loan|the\s+loan|debts?|pensions?|funds?|shares?|investments?|childcare|insurance|bills?|expenses?)\b/iu;

function scaleFor(token) {
  const normalized = String(token || '').toLowerCase();
  if (['k', 'grand', 'thousand'].includes(normalized)) return 1_000;
  if (['m', 'million'].includes(normalized)) return 1_000_000;
  if (['bn', 'billion'].includes(normalized)) return 1_000_000_000;
  return 1;
}

function currencyFor(...tokens) {
  for (const token of tokens) {
    const currency = CURRENCY_BY_TOKEN[String(token || '').toLowerCase()];
    if (currency) return currency;
  }
  return null;
}

function clauseBounds(text, start, end) {
  const isBarrier = (index) => {
    const token = text[index];
    if (!'.!?;\n'.includes(token)) return false;
    return token !== '.' || !(/\d/.test(text[index - 1] || '') && /\d/.test(text[index + 1] || ''));
  };
  let left = -1;
  for (let index = start - 1; index >= 0; index -= 1) {
    if (isBarrier(index)) { left = index; break; }
  }
  let right = text.length;
  for (let index = end; index < text.length; index += 1) {
    if (isBarrier(index)) { right = index + 1; break; }
  }
  return { start: left + 1, end: right };
}

function adjacentUnit(text, end) {
  const match = /^\s*(?:(?:a|per|each)\s+)?(days?|weeks?|months?|years?|annum)\b/iu
    .exec(text.slice(end, end + 32));
  if (!match) return null;
  const token = match[1].toLowerCase();
  if (token === 'annum') return 'year';
  return token.replace(/s$/, '');
}

function identifierLike(text, start) {
  const before = text.slice(Math.max(0, start - 90), start);
  return IDENTIFIER_BEFORE.some((pattern) => pattern.test(before));
}

function contextualFinancialValue(text, start, end) {
  const before = text.slice(Math.max(0, start - 100), start);
  const after = text.slice(end, Math.min(text.length, end + 80));
  if (DIRECT_FINANCIAL_SUBJECT_BEFORE.test(before)
    || LINKED_FINANCIAL_SUBJECT_BEFORE.test(before)
    || FINANCIAL_ACTION_BEFORE.test(before)
    || FINANCIAL_OBJECT_AFTER.test(after)) return true;
  // A frequency/term is meaningful only beside a financial cue. This catches
  // "rent is 950 each month" and "22 years left on the mortgage" without
  // turning an ordinary age into a repair obligation.
  if (!adjacentUnit(text, end)) return false;
  return /\b(?:rent|payment|repayment|income|salary|bonus|mortgage|loan|debt|spend|expense|cost|premium|contribution)\b/iu
    .test(text.slice(Math.max(0, start - 100), Math.min(text.length, end + 100)));
}

function termValueContext(text, start, end, unit) {
  if (!['month', 'year'].includes(unit)) return false;
  const before = text.slice(Math.max(0, start - 70), start);
  const after = text.slice(end, Math.min(text.length, end + 80));
  if (/^\s*(?:(?:a|per|each)\s+)?(?:months?|years?)\s+(?:remaining|left)(?:\s+on)?\s+(?:the\s+)?(?:mortgage|loan)\b/iu
    .test(after)) return true;
  if (/\b(?:payment|repayment|rent)\b[^.!?;\n]{0,45}$/iu.test(before)) return false;
  return /\b(?:mortgage|loan|term|remaining)\b[^.!?;,\n]{0,45}$/iu.test(before);
}

function explicitlyValueBearing(text, {
  start, end, value, currency = null, percent = false, scaled = false
}) {
  // An explicit currency or percent sign wins. Otherwise strong identifier and
  // non-financial count syntax wins, before the broad >=1000 safety net.
  if (currency || percent) return true;
  if (identifierLike(text, start)) return false;
  if (NON_VALUE_COUNT_AFTER.test(text.slice(end, end + 40))) return false;
  return scaled || Math.abs(value) >= 1_000 || contextualFinancialValue(text, start, end);
}

function spokenTokensAreAdjacent(text, previous, current) {
  // Whitespace and a word-forming hyphen are the only separators inside one
  // spoken number. Sentence punctuation must stop the parse: otherwise
  // "twenty. Five thousand" becomes the invented value twenty-five thousand.
  const gap = text.slice(previous.end, current.start);
  return /^[ \t]*(?:[-‐‑][ \t]*)?$/.test(gap);
}

function occurrence(text, {
  start, end, value, kind, currency = null, unit = null, financial = true
}) {
  const bounds = clauseBounds(text, start, end);
  return Object.freeze({
    evidenceId: `value:${start}:${end}`,
    start,
    end,
    raw: text.slice(start, end),
    value,
    kind,
    currency,
    unit,
    // Whether this occurrence is an explicit FINANCIAL value, as opposed to a
    // number the client merely said. Both are inventoried from one parse; only
    // the financial ones carry a capture obligation. See
    // extractNumericOccurrences for why the distinction has to be recorded
    // rather than filtered away at the source.
    financial,
    contextStart: bounds.start,
    contextEnd: bounds.end,
    contextText: text.slice(bounds.start, bounds.end).trim(),
    superseded: false
  });
}

function digitOccurrences(text) {
  const found = [];
  for (const match of text.matchAll(DIGIT_VALUE)) {
    const base = Number(match[2].replaceAll(',', ''));
    if (!Number.isFinite(base)) continue;
    const scale = scaleFor(match[3]);
    const value = base * scale;
    const percent = Boolean(match[5]);
    const currency = currencyFor(match[1], match[4]);
    const yearLike = !currency && scale === 1 && !percent
      && Number.isInteger(value) && value >= 1900 && value <= 2100;
    const valueBearing = explicitlyValueBearing(text, {
      start: match.index,
      end: match.index + match[0].length,
      value,
      currency,
      percent,
      scaled: scale > 1
    });
    const adjacent = adjacentUnit(text, match.index + match[0].length);
    const termLike = !currency && !percent
      && termValueContext(text, match.index, match.index + match[0].length, adjacent);
    found.push(occurrence(text, {
      start: match.index,
      end: match.index + match[0].length,
      value,
      kind: percent ? 'percent' : termLike ? 'number' : 'money',
      currency,
      unit: percent ? 'percent' : adjacent,
      financial: valueBearing && !yearLike
    }));
  }
  return found;
}

function spokenOccurrences(text) {
  const tokens = [...text.matchAll(/\p{L}+/gu)].map((match) => ({
    word: match[0].toLowerCase(),
    start: match.index,
    end: match.index + match[0].length
  }));
  const found = [];
  for (let start = 0; start < tokens.length; start += 1) {
    const first = tokens[start].word;
    if (!Object.hasOwn(NUMBER_WORD_VALUES, first)
      && !(first === 'a' && Object.hasOwn(NUMBER_WORD_SCALES, tokens[start + 1]?.word))) continue;
    let total = 0;
    let group = 0;
    let decimal = '';
    let point = false;
    let consumed = 0;
    let usedScale = false;
    for (let index = start; index < tokens.length; index += 1) {
      if (index > start && !spokenTokensAreAdjacent(text, tokens[index - 1], tokens[index])) break;
      const token = tokens[index].word;
      if (token === 'and' && consumed > 0 && !point) {
        const next = tokens[index + 1]?.word;
        if (Object.hasOwn(NUMBER_WORD_VALUES, next)
          || Object.hasOwn(NUMBER_WORD_SCALES, next)) {
          consumed += 1;
          continue;
        }
        break;
      }
      if (token === 'point' && consumed > 0 && !point) {
        point = true;
        consumed += 1;
        continue;
      }
      if (point) {
        const digit = NUMBER_WORD_VALUES[token];
        if (!Number.isInteger(digit) || digit < 0 || digit > 9) break;
        decimal += String(digit);
        consumed += 1;
        continue;
      }
      if (token === 'a' && Object.hasOwn(NUMBER_WORD_SCALES, tokens[index + 1]?.word)) {
        group += 1;
        consumed += 1;
        continue;
      }
      if (Object.hasOwn(NUMBER_WORD_VALUES, token)) {
        group += NUMBER_WORD_VALUES[token];
        consumed += 1;
        continue;
      }
      if (!Object.hasOwn(NUMBER_WORD_SCALES, token)) break;
      usedScale = true;
      const scale = NUMBER_WORD_SCALES[token];
      if (scale === 100) group = (group || 1) * scale;
      else {
        total += (group || 1) * scale;
        group = 0;
      }
      consumed += 1;
    }
    if (!consumed || (point && !decimal)) continue;
    const endToken = tokens[start + consumed - 1];
    const suffix = text.slice(endToken.end, endToken.end + 24);
    const currencyMatch = /^\s*(euros?|pounds?|sterling|dollars?|EUR|GBP|USD)\b/i.exec(suffix);
    const percentMatch = /^\s*(%|percent\b|per\s+cent\b)/i.exec(suffix);
    const prefixText = text.slice(Math.max(0, tokens[start].start - 24), tokens[start].start);
    const currencyPrefix = new RegExp(`(${CURRENCY_TOKEN_SOURCE})\\s*$`, 'iu').exec(prefixText);
    const currency = currencyFor(currencyPrefix?.[1], currencyMatch?.[1]);
    const value = Number(`${total + group}${decimal ? `.${decimal}` : ''}`);
    const valueBearing = explicitlyValueBearing(text, {
      start: currencyPrefix
        ? tokens[start].start - currencyPrefix[0].length
        : tokens[start].start,
      end: endToken.end,
      value,
      currency,
      percent: Boolean(percentMatch),
      // "Eight hundred" is still a low value: require financial context just
      // as the digit form 800 does. Large spoken values already satisfy the
      // numeric threshold, while an explicit currency remains authoritative.
      scaled: usedScale && Math.abs(value) >= 1_000
    });
    if (!Number.isFinite(value)) continue;
    const occurrenceStart = currencyPrefix
      ? tokens[start].start - currencyPrefix[0].length
      : tokens[start].start;
    const end = endToken.end + (currencyMatch?.[0].length || percentMatch?.[0].length || 0);
    const adjacent = adjacentUnit(text, end);
    const termLike = !currency && !percentMatch
      && termValueContext(text, occurrenceStart, end, adjacent);
    found.push(occurrence(text, {
      start: occurrenceStart,
      end,
      value,
      kind: percentMatch ? 'percent' : termLike ? 'number' : 'money',
      currency,
      unit: percentMatch ? 'percent' : adjacent,
      financial: valueBearing
    }));
    start += consumed - 1;
  }
  return found;
}

function withCorrectionState(text, occurrences) {
  return occurrences.map((item, index) => {
    const next = occurrences[index + 1];
    if (!next) return item;
    const between = text.slice(item.end, next.start);
    // An explicit anaphor ("it/that/the amount") plus a compatible value kind
    // is the minimum deterministic proof that the speaker is replacing this
    // occurrence. A bare "sorry/actually" can introduce another fact whose
    // subject comes after its value, so it must leave both occurrences active
    // for the ordinary reconciliation path to classify.
    const compatible = item.kind === next.kind
      && (!item.currency || !next.currency || item.currency === next.currency);
    if (!compatible || !DIRECT_CORRECTION_BRIDGE.test(between)) return item;
    return Object.freeze({ ...item, superseded: true });
  });
}

/**
 * EVERY number the client said, occurrence-addressed, financial or not.
 *
 * This is the single numeric scan the rest of the system builds on. Callers
 * that need "was this figure actually spoken" read this; callers that need
 * "which explicit financial values carry a capture obligation" read
 * extractValueEvidence, which is the financial subset of the same parse.
 *
 * Keeping both views on one parse is deliberate. Separate scanners drift, and
 * the drift is invisible until one of them refuses a figure the other accepted.
 */
export function extractNumericOccurrences(transcript) {
  const text = String(transcript || '');
  return [...digitOccurrences(text), ...spokenOccurrences(text)]
    .sort((left, right) => left.start - right.start || left.end - right.end)
    // A word parser and digit parser cannot normally overlap, but keep the
    // invariant explicit so every source span has one identity.
    .filter((item, index, all) => !all.slice(0, index)
      .some((other) => other.start === item.start && other.end === item.end));
}

/**
 * Magnitude words the value parser never consumes, and the shape of a scale
 * continuation it cannot read past.
 *
 * These exist for ONE purpose: letting the scan report that it has under-read a
 * spoken figure, so semantic review can be trusted with the reading instead.
 * They never produce a value and never widen what extractNumericOccurrences
 * returns, so adding a token here cannot change any existing extraction — it
 * can only move a span from "the parser is sure" to "ask the planner".
 *
 * This is deliberately not a repair of the spoken-number grammar. Teaching the
 * parser to read "two and a half thousand" would put it back in charge of
 * meaning, which is the arrangement being retired.
 */
const UNPARSED_MAGNITUDE_AFTER = /^\s*(?:grand|k)\b/iu;
const UNREAD_SCALE_CONTINUATION = /^\s+and\s+(?:\p{L}+\s+){0,3}?(?:thousand|million|billion|grand|k)\b/iu;

/** A spoken figure the scan could only read the leading part of. */
function spanIsUnderRead(text, item) {
  // Digits are exact by construction; only word-spelled figures under-read.
  if (!/\p{L}/u.test(text.slice(item.start, item.end))) return false;
  const rest = text.slice(item.end);
  return UNPARSED_MAGNITUDE_AFTER.test(rest) || UNREAD_SCALE_CONTINUATION.test(rest);
}

/**
 * Every numeric span in a transcript, each saying whether the scan actually
 * finished reading it.
 *
 * `resolved: false` does not mean "no number here" and it does not mean the
 * scanned value is wrong to within a rounding error — it means the value is a
 * TRUNCATION. "two and a half thousand" scans as 2 and "a hundred and eighty
 * grand" scans as 180, so treating either as the client's figure is not a near
 * miss, it is three orders of magnitude. A caller must never spend an
 * under-read value as though the client said it.
 */
export function numericEvidenceSpans(transcript) {
  const text = String(transcript || '');
  return extractNumericOccurrences(text).map((item) => Object.freeze({
    start: item.start,
    end: item.end,
    value: item.value,
    kind: item.kind,
    resolved: !spanIsUnderRead(text, item)
  }));
}

/** Return active, occurrence-addressed FINANCIAL evidence in source order. */
export function extractValueEvidence(transcript, { includeSuperseded = false } = {}) {
  const text = String(transcript || '');
  const ordered = extractNumericOccurrences(text).filter((item) => item.financial);
  const classified = withCorrectionState(text, ordered);
  return classified.filter((item) => includeSuperseded || !item.superseded);
}

function numericLeaves(value, found = [], path = [], inheritedCurrency = null) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    found.push({ value, path, currency: inheritedCurrency, unit: null });
    return found;
  }
  if (typeof value === 'string' && /^-?\d[\d,.]*(?:\.\d+)?$/.test(value.trim())) {
    found.push({ value: Number(value.replaceAll(',', '')), path, currency: inheritedCurrency, unit: null });
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  const currency = currencyFor(value.currency) || inheritedCurrency;
  if (Array.isArray(value)) {
    value.forEach((item, index) => numericLeaves(item, found, [...path, String(index)], currency));
    return found;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'currency') continue;
    numericLeaves(item, found, [...path, key], currency);
  }
  return found;
}

function candidateRecords(input) {
  if (!input) return [];
  if (typeof input === 'object' && typeof input.evidenceId === 'string' && input.evidenceId) return [];
  if (Array.isArray(input)) return input
    // An accepted provenance record is occurrence-addressed and is consumed by
    // valueEvidenceCoverage before numeric matching. Do not also turn any
    // diagnostic number it carries into a free leaf that could cover a sibling.
    .filter((value) => !(value && typeof value === 'object'
      && typeof value.evidenceId === 'string' && value.evidenceId))
    .map((value) => ({ value, evidenceText: '' }));
  if (Array.isArray(input.goalCandidates)
    || Array.isArray(input.semanticFacts)
    || Array.isArray(input.positions)) {
    return [
      ...(input.semanticFacts || []).map((item) => ({
        candidateId: item.candidateId,
        value: item.value,
        evidenceText: item.evidenceText || ''
      })),
      ...(input.positions || []).map((item) => ({
        candidateId: item.candidateId,
        value: item.amount,
        evidenceText: item.evidenceText || ''
      }))
    ];
  }
  return [{ value: input, evidenceText: '' }];
}

function provenanceRecords(input) {
  const values = Array.isArray(input) ? input : [input];
  return values.filter((value) => value && typeof value === 'object'
    && typeof value.evidenceId === 'string' && value.evidenceId);
}

function valuesMatch(leaf, item) {
  const numeric = Math.abs(leaf.value - item.value) <= Math.max(1e-9, Math.abs(item.value) * 1e-9);
  const percentFraction = item.kind === 'percent'
    && Math.abs(leaf.value - item.value / 100) <= 1e-9;
  if (!numeric && !percentFraction) return false;
  // An unqualified amount uses the product's signed Irish-jurisdiction EUR
  // default; it must never authorise a planner to attach GBP or USD. Explicit
  // foreign currency remains bound to its own occurrence.
  if (leaf.currency && (item.currency || 'EUR') !== leaf.currency) return false;
  return true;
}

function recordLeaves(record) {
  return numericLeaves(record.value).map((leaf) => ({ ...leaf, record }));
}

function containsCurrency(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsCurrency);
  if (typeof value.currency === 'string' && currencyFor(value.currency)) return true;
  return Object.values(value).some(containsCurrency);
}

function numericValueMatches(leaf, item) {
  return Math.abs(leaf.value - item.value) <= Math.max(1e-9, Math.abs(item.value) * 1e-9)
    || (item.kind === 'percent' && Math.abs(leaf.value - item.value / 100) <= 1e-9);
}

/**
 * One-to-one multiset coverage. Matching consumes an occurrence, so two
 * distinct €25k holdings remain two obligations even when their values match.
 */
export function valueEvidenceCoverage(transcript, extractedOrValues, {
  provenance: suppliedProvenance = []
} = {}) {
  const evidence = extractValueEvidence(transcript);
  const leaves = candidateRecords(extractedOrValues).flatMap(recordLeaves);
  const provenance = new Map();
  const leafValuesByCandidate = new Map();
  for (const leaf of leaves) {
    const candidateId = leaf.record.candidateId;
    if (!candidateId) continue;
    if (!leafValuesByCandidate.has(candidateId)) leafValuesByCandidate.set(candidateId, []);
    leafValuesByCandidate.get(candidateId).push(leaf);
  }
  const records = [
    // An occurrence binding resolved upstream — by the live numeric guard,
    // which knows the slot, the owner cues and the position label — is the
    // authoritative answer to "which occurrence is this". Re-deriving it here
    // from the quote alone is how a whole-turn citation turned two legitimate
    // equal values into one unresolvable ambiguity.
    ...provenanceRecords(suppliedProvenance),
    ...provenanceRecords(extractedOrValues)
  ];
  for (const record of records) {
    // Evidence ids identify one source occurrence. A duplicate record must not
    // manufacture extra coverage, so the first accepted provenance wins.
    if (provenance.has(record.evidenceId)) continue;
    // Provenance names an occurrence; it never asserts a value. A record whose
    // candidate holds no leaf matching that occurrence is ignored rather than
    // trusted, so a wrong binding cannot launder a figure into coverage.
    const claimed = leafValuesByCandidate.get(record.candidateId);
    const occurrenceHere = evidence.find((item) => item.evidenceId === record.evidenceId);
    if (claimed && occurrenceHere
      && !claimed.some((leaf) => valuesMatch(leaf, occurrenceHere))) continue;
    provenance.set(record.evidenceId, record);
  }
  const usedLeaves = new Set();
  const covered = [];
  const uncovered = [];
  for (const item of evidence) {
    const exact = provenance.get(item.evidenceId);
    if (exact) {
      // A resolved occurrence CONSUMES its leaf, exactly as a value match does.
      //
      // The candidate's own values are still the budget. Without this, one
      // candidate holding a single €25,000 could be credited with both
      // €25,000 occurrences in a turn and the second holding's omission would
      // disappear — the precise failure this inventory exists to catch.
      //
      // When the caller supplied provenance alone, with no candidate values to
      // check against (the background audit passes accepted write records),
      // there is no budget to spend and the provenance is the whole claim.
      const claimed = leafValuesByCandidate.get(exact.candidateId);
      const leafIndex = claimed
        ? leaves.findIndex((leaf, index) => (
          !usedLeaves.has(index)
          && leaf.record.candidateId === exact.candidateId
          && valuesMatch(leaf, item)
        ))
        : -1;
      if (claimed && leafIndex < 0) {
        // Every value this candidate holds is already accounted for elsewhere,
        // so it cannot also account for this occurrence.
        uncovered.push(item);
        continue;
      }
      if (leafIndex >= 0) usedLeaves.add(leafIndex);
      covered.push({ ...item, candidateId: exact.candidateId || null });
      continue;
    }
    const index = leaves.findIndex((leaf, leafIndex) => {
      if (usedLeaves.has(leafIndex) || !valuesMatch(leaf, item)) return false;
      const quoted = String(leaf.record.evidenceText || '');
      if (!quoted) return true;
      const quoteStart = String(transcript).indexOf(quoted);
      return quoteStart >= 0 && String(transcript).indexOf(quoted, quoteStart + 1) < 0
        && item.start >= quoteStart && item.end <= quoteStart + quoted.length;
    });
    if (index < 0) uncovered.push(item);
    else {
      usedLeaves.add(index);
      covered.push({ ...item, candidateId: leaves[index].record.candidateId || null });
    }
  }
  return Object.freeze({
    evidence,
    covered,
    uncovered,
    candidateLeafCount: leaves.length,
    provenanceCount: provenance.size
  });
}

/** A bounded, content-minimal list for one repair/reconciliation review. */
export function boundedUncoveredValueEvidence(coverage, { limit = 8 } = {}) {
  const all = Array.isArray(coverage?.uncovered) ? coverage.uncovered : [];
  const requested = Number(limit);
  const boundedLimit = Number.isFinite(requested)
    ? Math.max(0, Math.min(12, Math.floor(requested)))
    : 8;
  const items = all.slice(0, boundedLimit).map((item) => ({
    evidenceId: item.evidenceId,
    ...(item.turnId ? { turnId: item.turnId } : {}),
    start: item.start,
    end: item.end,
    valueText: item.raw,
    normalizedValue: item.value,
    kind: item.kind,
    currency: item.currency,
    unit: item.unit,
    contextText: item.contextText
  }));
  return Object.freeze({ items, overflowCount: Math.max(0, all.length - items.length) });
}

/**
 * Numeric grounding for the legacy/agent extraction lane. A numeric candidate
 * must cite one unique exact client span and every leaf must be covered there.
 * The returned extraction is safe to pass through the ordinary mapper.
 */
export function groundPlannerExtraction(extraction, transcript, {
  allowedEvidenceIds = null,
  provenance = []
} = {}) {
  if (!extraction) return extraction;
  const text = String(transcript || '');
  const allowed = allowedEvidenceIds ? new Set(allowedEvidenceIds) : null;
  const invalidCandidates = [...(extraction.invalidCandidates || [])];
  const internalIdByOriginal = new Map();
  const relabel = (candidate, candidateId) => {
    if (candidate.candidateId && !internalIdByOriginal.has(candidate.candidateId)) {
      internalIdByOriginal.set(candidate.candidateId, candidateId);
    }
    return { ...candidate, candidateId };
  };
  const semanticFacts = (extraction.semanticFacts || [])
    .map((candidate, index) => relabel(candidate, `__ground_fact_${index}`));
  const positions = (extraction.positions || [])
    .map((candidate, index) => relabel(candidate, `__ground_position_${index}`));
  const globalCoverage = valueEvidenceCoverage(text, { semanticFacts, positions }, {
    provenance: (Array.isArray(provenance) ? provenance : []).map((record) => ({
      ...record,
      candidateId: internalIdByOriginal.get(record?.candidateId) ?? record?.candidateId
    }))
  });
  const coveredByCandidate = new Map();
  for (const item of globalCoverage.covered) {
    const existing = coveredByCandidate.get(item.candidateId) || [];
    existing.push(item);
    coveredByCandidate.set(item.candidateId, existing);
  }
  const ground = (items, kind) => (items || []).filter((candidate, index) => {
    const leaves = numericLeaves(kind === 'position' ? candidate.amount : candidate.value);
    if (leaves.length === 0) return true;
    const quote = String(candidate.evidenceText || '');
    const start = quote ? text.indexOf(quote) : -1;
    const exact = start >= 0 && text.indexOf(quote, start + 1) < 0;
    const quotedEvidence = exact ? extractValueEvidence(quote) : [];
    // This layer inventories financial values, not every number in the
    // profile. Leave ages, dates and counts to their existing fact contracts.
    // Position amounts are always financial; semantic facts opt in when their
    // own cited span contains a matching value-bearing occurrence (or carries
    // an explicit money currency). Matching ignores currency only for this
    // classification step, so a wrong-currency money candidate is still
    // subject to grounding and then refused below.
    const value = kind === 'position' ? candidate.amount : candidate.value;
    const financial = kind === 'position'
      || containsCurrency(value)
      || quotedEvidence.some((item) => leaves.some((leaf) => numericValueMatches(leaf, item)));
    if (!financial) return true;
    const internalId = kind === 'position' ? `__ground_position_${index}` : `__ground_fact_${index}`;
    // Global one-to-one assignment is what keeps repeated equal values honest:
    // two €25k candidates consume two source occurrences, and a single stated
    // €25k can satisfy only one of them. That assignment — not the width of
    // the quote — is the ambiguity test. A live candidate cites its whole
    // finalized turn by construction, so requiring the value to appear once
    // inside the quote refused every legitimate repeated figure, including
    // "contributing 5% with a 5% employer match".
    const covered = coveredByCandidate.get(internalId) || [];
    // INVENTORY MISS IS NOT AN EVIDENCE FAILURE.
    //
    // The financial inventory recognises an unmarked low amount only beside a
    // financial subject it knows, so "the creche is 900 a month" produces no
    // occurrence at all. That means "this layer cannot classify it", not "the
    // client never said it" — the same distinction the reconciliation number
    // grounder already makes. Such a leaf is grounded against the plain
    // numeric scan instead, and carries no coverage obligation. It keeps the
    // Irish jurisdiction default: an unqualified amount is EUR and can never
    // authorise a foreign currency.
    const inventoried = leaves.filter((leaf) => (
      quotedEvidence.some((item) => numericValueMatches(leaf, item))
    ));
    const unclassified = leaves.filter((leaf) => !inventoried.includes(leaf));
    const quotedNumbers = exact ? extractNumericOccurrences(quote) : [];
    const unclassifiedGrounded = unclassified.every((leaf) => (
      (!leaf.currency || leaf.currency === 'EUR')
      && quotedNumbers.some((item) => numericValueMatches(leaf, item))
    ));
    const coveredAll = exact && covered.length >= inventoried.length;
    const sourceIds = covered.map((item) => item.evidenceId);
    const withinRepair = !allowed || (sourceIds.length > 0
      && sourceIds.every((id) => allowed.has(id)));
    if (exact && coveredAll && unclassifiedGrounded && withinRepair) return true;
    invalidCandidates.push({
      candidateId: candidate.candidateId || null,
      factId: kind === 'position' ? null : candidate.factId || null,
      errorCode: allowed && !withinRepair
        ? 'realtime_planner_candidate_unsolicited'
        : 'realtime_planner_candidate_evidence_unsupported'
    });
    return false;
  });
  return Object.freeze({
    ...extraction,
    semanticFacts: ground(extraction.semanticFacts, 'fact'),
    positions: ground(extraction.positions, 'position'),
    invalidCandidates
  });
}
