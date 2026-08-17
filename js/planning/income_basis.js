/**
 * GROSS OR NET — decided once, from the client's own words.
 *
 * WHY THIS IS NOT IN A PROMPT. `income_sources` stores `grossAnnual` or
 * `netAnnual`, and nothing anywhere decided which. The basis was simply whichever
 * key the caller happened to use, so the live model and the background
 * reconciler could read the same sentence and canonicalise it differently — or,
 * as a real planner did on a paid probe, refuse to canonicalise "I am on 95,000
 * a year" at all and ask which it was. That is a reasonable question for a model
 * with no rule to follow, and the wrong question to put to a client who has just
 * told you their salary.
 *
 * So the rule lives here, in the shared planning layer both lanes already
 * import, and is applied inside the shared canonicalisation mapper. Neither lane
 * has its own copy and neither can drift.
 *
 * THE RULE, IN THE ORDER IT IS APPLIED:
 *   an explicit net/take-home cue          -> net
 *   an explicit gross cue                  -> gross
 *   an ordinary statement of pay, no cue   -> gross
 *   both cues in one statement             -> refuse, ask
 *   a caller-stated basis that CONTRADICTS
 *     the client's wording                 -> refuse, ask
 *
 * WHAT IT IS NOT. It is an interpretation rule, not permission to invent a
 * figure. It never supplies, scales or converts an amount: the number still has
 * to be one the client said, and the numeric-grounding guards are untouched. A
 * monthly figure is refused rather than annualised, because no annualisation
 * rule exists in this contract and inventing one here would be inventing money.
 */

/** Take-home wording. Deliberately broad: a false NET is safer than a false GROSS. */
const NET_CUES = [
  /\bnet\b/i,
  /\btake[-\s]?home\b/i,
  /\btakes?\s+home\b/i,
  /\bafter[-\s]tax(?:es)?\b/i,
  /\bafter\s+deductions?\b/i,
  /\bin\s+the\s+hand\b/i,
  /\b(?:hits|lands\s+in|goes\s+into|into)\s+my\s+(?:bank\s+)?account\b/i,
  /\bi\s+clear\b/i
];

const GROSS_CUES = [
  /\bgross\b/i,
  /\bbefore[-\s]tax(?:es)?\b/i,
  /\bpre[-\s]tax\b/i,
  /\bbefore\s+deductions?\b/i
];

/** A cadence the annual slots cannot take without a conversion that does not exist. */
const SUB_ANNUAL_CUES = [
  /\bper\s+month\b/i,
  /\ba\s+month\b/i,
  /\beach\s+month\b/i,
  /\bmonthly\b/i,
  /\bper\s+week\b/i,
  /\ba\s+week\b/i,
  /\bweekly\b/i,
  /\bfortnight(?:ly)?\b/i
];

const matches = (patterns, text) => patterns.some((pattern) => pattern.test(text));

/**
 * What the client's wording says about the basis.
 *
 * @returns {'gross'|'net'|'conflicting'|null} null when they simply stated pay.
 */
export function classifyIncomeBasis(evidenceText) {
  const text = String(evidenceText || '');
  if (!text.trim()) return null;
  const net = matches(NET_CUES, text);
  const gross = matches(GROSS_CUES, text);
  if (net && gross) return 'conflicting';
  if (net) return 'net';
  if (gross) return 'gross';
  return null;
}

/** True when the figure was described at a cadence the annual slots cannot hold. */
export function statesSubAnnualCadence(evidenceText) {
  return matches(SUB_ANNUAL_CUES, String(evidenceText || ''));
}

/**
 * Which annual slot an income amount belongs in.
 *
 * @param {'gross'|'net'|null} statedBasis which key the caller used, if any
 * @param {string} evidenceText the client's own words for this figure
 * @returns {{basis: 'gross'|'net'}|{refused: true, reason: string}}
 */
export function resolveIncomeBasis({ statedBasis = null, evidenceText = '' } = {}) {
  const cue = classifyIncomeBasis(evidenceText);

  // Two bases in one breath. The caller may still disambiguate by naming one
  // explicitly — "my gross salary is 95k but I take home 60k" is two facts, and
  // whichever it is saving, it has said which. With nothing stated there is no
  // safe reading, and guessing would merge two different figures into one slot.
  if (cue === 'conflicting') {
    return statedBasis
      ? { basis: statedBasis }
      : { refused: true, reason: 'income_basis_conflicting' };
  }

  // THE DEFAULT NEVER OVERRIDES THE CLIENT. A caller asserting `grossAnnual`
  // over "I take home 60,000" is contradicting them, and the honest answer is
  // to ask rather than to silently pick a side.
  if (statedBasis && cue && statedBasis !== cue) {
    return { refused: true, reason: 'income_basis_contradicts_evidence' };
  }
  if (statedBasis) return { basis: statedBasis };
  if (cue) return { basis: cue };

  // An ordinary statement of pay, with nothing to suggest take-home.
  return { basis: 'gross' };
}
