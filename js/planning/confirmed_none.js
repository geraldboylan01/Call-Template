/**
 * "THE CLIENT SAID THERE ARE NONE" — one grammar, both lanes.
 *
 * The live lane needs it to accept a `confirm_none` tool call. The background
 * reconciler needs the SAME judgement to accept a completion note that records
 * an absence, because a completion note now writes the confirmed-none marker
 * that module readiness reads. Two copies would drift, and the copy that drifted
 * looser would decide whether a module runs on a household it does not know.
 *
 * It lives in js/planning because that is what both lanes may import: the worker
 * imports from here, never the other way round. Same reasoning as income basis.
 */


/**
 * Words a client puts between "no" and "debt" when they mean it.
 *
 * A CLOSED SET, and that is the safety property. The obvious fix -- allowing any
 * word or two -- also matches "no idea about my loans" and "no details on the
 * debts", turning an admission of uncertainty into a categorical claim that the
 * client has none. Every entry here describes debt; none of them describes not
 * knowing.
 */
const DEBT_MODIFIER = '(?:household|personal|family|joint|other|outstanding|remaining|consumer|unsecured|secured|short-term|long-term|current|monthly)\\s+';

/** The nouns a client uses for a debt they are denying having. */
const DEBT_NOUN = '(?:debts?|liabilit(?:y|ies)|borrowings?)';

const LIABILITY_CONFIRMED_NONE = new RegExp(
  '\\b(?:'
  // "no debts", "no household debt", "no outstanding liabilities"
  + `(?:no|without)\\s+(?:any\\s+)?(?:${DEBT_MODIFIER}){0,2}${DEBT_NOUN}`
  // "no loans or other debts"
  + '|(?:no|without)\\s+(?:any\\s+)?loans?\\s+or\\s+(?:other\\s+)?debts?'
  // A LIST. "no loans, car finance, credit-card balances or other debts" --
  // the client enumerating what they do not have is the most emphatic form of
  // the claim, and it was the one form the pattern refused.
  + `|(?:no|without)\\s+(?:any\\s+)?loans?\\b[^.!?]{0,90}\\bor\\s+(?:any\\s+)?(?:other\\s+)?${DEBT_NOUN}`
  // "I don't have any loan or mortgage repayments"
  + '|(?:do not|don\'t)\\s+have\\s+(?:any\\s+)?(?:loan|mortgage|credit|card|finance|debt)[^.!?]{0,40}\\brepayments?'
  // The original open-ended form, with its uncertainty guard intact.
  + `|(?:do not|don't)\\s+(?:have|owe|carry)\\s+any\\s+(?!figures?|details?|balances?|amounts?|idea|clue)[^.!?]{0,100}\\b${DEBT_NOUN}\\b`
  + ')\\b',
  'i'
);

/**
 * "MY PARTNER DOESN'T HAVE A PENSION" IS THE SAME ANSWER AS "NO PENSION".
 *
 * These patterns knew `don't have` and not `doesn't have`, and required the
 * object to follow the negation immediately. On the first real live-model call
 * the client said "My partner doesn't have a pension of their own", the lane
 * refused it, the model asked again, the client said "Yes", the lane refused
 * that too — four turns of the same question, and the analysis never became
 * ready. The client had answered twice.
 *
 * So the negation grammar is written ONCE here and shared by every fact, rather
 * than nine near-identical regexes each missing a different conjugation:
 *
 *   subject   i / we / he / she / they / my partner|spouse|husband|wife
 *   negation  do not | don't | does not | doesn't | did not | didn't
 *   verb      per fact — most are `have`, property is `own`, business adds `run`
 *   object    per fact, with up to three describing words allowed before it, so
 *             "no OCCUPATIONAL pension" reads as a no-pension answer
 *
 * `other` is excluded from those describing words on purpose: "no other
 * pensions" is a statement about the rest, not a categorical none.
 */
const NONE_SUBJECT = String.raw`(?:(?:i|we|he|she|they)|my\s+(?:partner|spouse|husband|wife))\s+`;
const NONE_NEGATION = String.raw`(?:do(?:es)?\s+not|do(?:es)?n't|did\s+not|didn't)`;
const NONE_QUALIFIER = String.raw`(?:(?!other)[A-Za-z-]+\s+){0,3}`;

/** One fact's "the client said there are none" pattern, built from its object. */
function confirmedNonePattern(object, { verbs = 'have', extra = '' } = {}) {
  const determiner = String.raw`(?:a\s+|an\s+|any\s+|their\s+|his\s+|her\s+|its\s+)?`;
  const gap = `${determiner}${NONE_QUALIFIER}`;
  const negated = `(?:${NONE_SUBJECT})?${NONE_NEGATION}\\s+(?:${verbs})\\s+`;
  return new RegExp(
    '\\b(?:'
      // "no pension", "has no occupational pension", "without any pensions".
      // "no OTHER pensions" is excluded here rather than inside the qualifier:
      // it is a statement about the rest of the set, not a categorical none,
      // and the exclusion has to bind to the word right after "no".
      + `(?:no|without)\\s+(?!(?:other|further|additional|more)\\b)${gap}${object}`
      // "doesn't have a pension", "my partner does not own any property"
      + `|${negated}${gap}${object}`
      // "no, they don't have one" — the object as a bare pronoun
      + `|${negated}(?:one|any)\\b`
      + (extra ? `|${extra}` : '')
      + ')',
    'iu'
  );
}

const CONFIRMED_NONE_SUPPORT = Object.freeze({
  partner_person: confirmedNonePattern('(?:partner|spouse|husband|wife)', {
    extra: String.raw`i(?:\s+am|'m)\s+single`
  }),
  income_sources: confirmedNonePattern('(?:income|earnings|wages|salary)'),
  asset_position: confirmedNonePattern('(?:cash\\s+)?(?:savings?|investments?|assets?)', {
    verbs: 'have|own|hold'
  }),
  liability_position: LIABILITY_CONFIRMED_NONE,
  mortgage_position: confirmedNonePattern('mortgages?'),
  loan_position: confirmedNonePattern('loans?'),
  property_position: confirmedNonePattern('(?:property|properties|home|house)', {
    verbs: 'own|have'
  }),
  business_position: confirmedNonePattern(
    '(?:business(?:es)?|compan(?:y|ies)|business\\s+interests?)',
    { verbs: 'have|own|run' }
  ),
  pension_positions: confirmedNonePattern('(?:pensions?|retirement\\s+funds?)'),
  dependants: confirmedNonePattern('(?:dependants?|dependents?|children|kids)')
});

const CONFIRMED_NONE_CORRECTION_OBJECTS = Object.freeze({
  partner_person: '(?:partner|spouse|husband|wife|boyfriend|girlfriend)',
  income_sources: '(?:income|earnings|wages|salary)',
  asset_position: '(?:cash|savings?|investments?|assets?|funds?)',
  liability_position:
    '(?:debts?|loans?|liabilit(?:y|ies)|mortgages?|credit cards?|cards?(?: balances?)?|'
    + 'overdrafts?|car finance|hire purchase)',
  mortgage_position: 'mortgage',
  loan_position: '(?:loans?|car finance|hire purchase)',
  property_position: '(?:property|properties|home|house|land|apartment|flat)',
  business_position: '(?:business(?:es)?|compan(?:y|ies)|business interests?)',
  pension_positions: '(?:pensions?|retirement funds?|PRSAs?|occupational schemes?)',
  dependants: '(?:dependants?|dependents?|children|kids?|sons?|daughters?|boys?|girls?)'
});

const DENIED_ABSENCE_PREFIX =
  /\b(?:is(?:\s+not|n't)\s+true\s+that|not\s+true\s+that|did(?:\s+not|n't)\s+(?:say|mean|claim|confirm)|can(?:\s+not|'t)\s+(?:say|confirm|claim)|ask(?:ed|ing)?\s+(?:me\s+)?(?:whether|if)|whether)\b/i;
const NON_CURRENT_ABSENCE_PREFIX =
  /\b(?:wish|if only|hope|used\s+to|formerly|previously|once|should|will|would|could|might|may|plan(?:ning)?|aim(?:ing)?|try(?:ing)?|want|intend|expect|suppose|hypothetically|think|believe|assume|guess|doubt|apparently|probably|possibly|maybe|perhaps|almost|nearly|virtually|practically|eventually|someday|goal)\b|\b(?:i|we|they|he|she)\s+had\b/i;
const NON_CURRENT_ABSENCE_SUFFIX =
  /^\s*(?:[,;:—-]\s*)*(?:by\s+(?:next|the)|next\s+(?:year|month)|eventually|someday|last\s+(?:year|month)|back\s+then|as\s+such|(?:as far as|so far as)\s+i\s+know|that\s+i\s+know(?:\s+of)?|probably|possibly|maybe|perhaps|apparently|really|i\s+(?:think|believe|suppose|guess))\b/i;

export {
  CONFIRMED_NONE_SUPPORT,
  CONFIRMED_NONE_CORRECTION_OBJECTS,
  DENIED_ABSENCE_PREFIX,
  NON_CURRENT_ABSENCE_PREFIX,
  NON_CURRENT_ABSENCE_SUFFIX,
  confirmedNonePattern
};
