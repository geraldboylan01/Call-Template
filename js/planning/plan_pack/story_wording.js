import { findForbiddenWording, findTypedFigures } from '../../plan_story_model.js';
import { namesAProvider } from '../figures/kinds.js';

const NUMBER_WORDS = /\b(?:zero|nil|nought|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion|half|halves|quarter|quarters|dozen|once|twice|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/i;
const GENDERED = /\b(?:he|him|his|himself|she|her|hers|herself)\b/i;
const COVER = /\b(?:premiums?|providers?|products?|sum\s+assured|cover\s+(?:amount|need|needed|required|gap|shortfall)|(?:amount|gap|shortfall|need)\s+(?:of|in|against|for)\s+(?:life\s+)?cover|(?:need|needs|required)\s+(?:more\s+)?(?:life\s+)?(?:insurance|cover)|(?:enough|adequate|sufficient|insufficient|additional|extra|more|less|suitable)\s+(?:life\s+)?(?:insurance|cover))\b/i;
const ESCAPE = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function storyWordRefusals(text, path, { otherRoutes = [] } = {}) {
  const errors = [], plain = text.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ');
  const add = (code, message) => errors.push({ code, path, message });
  if (findTypedFigures(text).length || findTypedFigures(plain).length || NUMBER_WORDS.test(plain)
    || /\b(?:for|after|within|lasts?|lasting)\s+(?:a|an|a couple of|a single)\s+(?:day|week|month|year)s?\b/i.test(plain)) add('typed_figure', 'Use a registered placeholder for every figure, including figures written in words.');
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
  const tokens = [], errors = [], pattern = /\{(@|\?explainer\.)?([a-z][A-Za-z0-9_.-]*)\}/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) tokens.push({ kind: 'text', text: text.slice(last, match.index) });
    tokens.push({ kind: match[1] === '?explainer.' ? 'explainer' : match[1] === '@' ? 'link' : 'fact', key: match[2] });
    last = match.index + match[0].length;
  }
  if (last < text.length) tokens.push({ kind: 'text', text: text.slice(last) });
  if (tokens.some(token => token.kind === 'text' && /[{}]/.test(token.text))) errors.push({ code: 'bad_placeholder', path,
    message: 'Use {key}, {@key}, {figure.id} or {?explainer.id}, with no other marker or stray brace.' });
  return { tokens, errors };
}

export function protectionOnly(text, keys, registry, sectionId) {
  const describedEvent = /\b(?:protection|insurance|cover|payout|death|died|income\s+stops?|cannot\s+work)\b/i.test(text);
  const context = sectionId === 'protecting' || describedEvent;
  return keys.filter(key => {
    const fact = registry[key];
    if (!fact || !['EUR', 'EUR/year', 'EUR/month', 'months', 'ratio'].includes(fact.unit)) return false;
    if (/^(?:current\.)?protection\./.test(key)) return !/\.(?:gap|months|statedMoneyReceived)(?:\.notApplicable)?$/.test(key);
    const reserve = /^(?:current\.)?position\.reserve(?:Months)?$/.test(key);
    return context && !(reserve && (!describedEvent || /\b(?:reserve|emergency)\b/i.test(text)));
  });
}
