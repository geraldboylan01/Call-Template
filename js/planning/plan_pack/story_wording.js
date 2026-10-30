import { findForbiddenWording, findTypedFigures, parseNarration } from '../../plan_story_model.js';
import { namesAProvider } from '../figures/kinds.js';

export const NUMBER_WORD_TERMS = Object.freeze(["zero", "nil", "nought", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety", "hundred", "hundreds", "thousand", "thousands", "million", "millions", "billion", "billions", "trillion", "trillions", "half", "halves", "quarter", "quarters", "dozen", "dozens", "once", "twice", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth", "thirtieth", "fortieth", "fiftieth", "sixtieth", "seventieth", "eightieth", "ninetieth", "hundredth", "thousandth"]);
const NUMBER_WORDS = new RegExp('\\b(?:' + NUMBER_WORD_TERMS.join('|') + ')\\b', 'i');
export const LIMITATION_WORDS = Object.freeze(['not shown', 'not calculated', 'not available', 'cannot calculate', 'could not show', 'unable to show']);
export const LIMITATION_PATTERN = new RegExp('\\b(?:' + LIMITATION_WORDS.join('|') + ')\\b', 'i');
const GENDERED = /\b(?:he|him|his|himself|she|her|hers|herself)\b/i;
const COVER = /\b(?:premiums?|providers?|products?|sum\s+assured|cover\s+(?:amount|need|needed|required|gap|shortfall)|(?:amount|gap|shortfall|need)\s+(?:of|in|against|for)\s+(?:life\s+)?cover|(?:need|needs|required)\s+(?:more\s+)?(?:life\s+)?(?:insurance|cover)|(?:enough|adequate|sufficient|insufficient|additional|extra|more|less|suitable)\s+(?:life\s+)?(?:insurance|cover))\b/i;
const ESCAPE = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function storyWordRefusals(text, path, { otherRoutes = [], tokens = [], registry = {} } = {}) {
  const errors = [], plain = text.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ');
  const add = (code, message) => errors.push({ code, path, message });
  // A unit immediately following a money token is a label, not a typed duration.
  const durationText = tokens.length ? tokens.map((token, i) => {
    if (token.kind !== 'text') return ' ';
    const previous = tokens[i - 1], fact = previous && registry[previous.key];
    return ['EUR', 'EUR/year', 'EUR/month'].includes(fact?.unit)
      ? token.text.replace(/^\s+a\s+(?:year|month)\b/i, ' ') : token.text;
  }).join(' ').normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ') : plain;
  if (findTypedFigures(text).length || findTypedFigures(plain).length || NUMBER_WORDS.test(plain)
    || /\b(?:a|an|a (?:couple|pair) of|a single)\s+(?:(?:second|minute|hour|day|week|fortnight|month|year|decade|euro|pound|dollar|percent)s?|centur(?:y|ies)|percentage points?|per cent)\b/i.test(durationText)) add('typed_figure', 'Use a registered placeholder for every figure, including figures written in words.');
  if (findForbiddenWording(plain).length || namesAProvider(plain)) add('forbidden_wording', 'Use neutral education-only wording without advice, ranking or provider names.');
  if (GENDERED.test(plain)) add('gendered_pronoun', 'Use names or you instead of gendered pronouns.');
  if (/\b(?:covered|affordable|balanced|fully funded|on track)\b/i.test(plain)) add('typed_state', 'Use a registered goal-state placeholder instead of typing a calculated conclusion.');
  if (COVER.test(plain)) add('protection_wording', 'Protection may describe the income gap, savings duration and stated money received, without cover needs, premiums, products or providers.');
  if (/[<>]/.test(plain) || /\]\s*\(/.test(plain)) add('authored_markup', 'Use plain narration and registered links; do not author markup or links.');
  if (/\b(?:other|another|next|previous)\s+(?:alternative|route|option|plan)\b/i.test(plain)
    || otherRoutes.some(route => [route.id, route.title].filter(Boolean).some(name => new RegExp('(?<![\\p{L}\\p{N}_])' + ESCAPE(name) + '(?![\\p{L}\\p{N}_])', 'iu').test(plain)))) {
    add('other_alternative', 'Refer only to this route and the current position.');
  }
  return errors;
}

/** The grammar has exactly three placeholders; malformed braces are refused. */
export function storyTokens(text, path) {
  try {
    return { tokens: parseNarration(text, path).map(token => token.type === 'text' ? { kind: 'text', text: token.text }
      : { kind: token.explainer ? 'explainer' : token.link ? 'link' : 'fact', key: token.explainer ? token.key.slice('explainer.'.length) : token.key }), errors: [] };
  } catch (error) {
    return { tokens: [], errors: [{ code: error.code, path: error.path, message: error.message }] };
  }
}

export function protectionOnly(tokens, registry, sectionId) {
  // Check the sentence containing each placeholder. Ordinary uses of “cover”
  // and a dated retirement statement do not describe a protection scenario.
  const sentences = [[]];
  for (const token of tokens) {
    if (token.kind !== 'text') { sentences.at(-1).push(token); continue; }
    const pieces = token.text.split(/(?<=[.!?])\s+/);
    pieces.forEach((text, i) => {
      if (i) sentences.push([]);
      sentences.at(-1).push({ kind: 'text', text });
    });
  }
  const refused = [];
  for (const sentence of sentences) {
    const text = sentence.filter(token => token.kind === 'text').map(token => token.text).join(' ');
    const conditional = /\b(?:if|when|case|scenario|illustration)\b/i.test(text);
    const retirement = !conditional && (/\bretire(?:ment|s|d)?\b/i.test(text)
      || sentence.some(token => registry[token.key]?.unit === 'year'));
    const event = /\b(?:death|dies?|died|cannot\s+work|could\s+not\s+work)\b/i.test(text)
      || /\bincome\s+(?:stops?|stopped)\b/i.test(text) && !retirement
      || /\b(?:if|when)\b[^.!?]*\bstop(?:s|ped)?\s+(?:working|earning)\b/i.test(text);
    for (const token of sentence.filter(token => token.kind === 'fact' || token.kind === 'link')) {
      const key = token.key, fact = registry[key];
      if (!fact || !['EUR', 'EUR/year', 'EUR/month', 'months', 'ratio'].includes(fact.unit)) continue;
      if (/^(?:current\.)?protection\./.test(key)) {
        if (!/\.(?:gap|months|statedMoneyReceived)(?:\.notApplicable)?$/.test(key)) refused.push(key);
      } else if (sectionId === 'protecting' || event) {
        const reserve = /^(?:current\.)?position\.reserve(?:Months)?$/.test(key);
        if (!(reserve && (!event || /\b(?:reserve|emergency)\b/i.test(text)))) refused.push(key);
      }
    }
  }
  return [...new Set(refused)];
}
