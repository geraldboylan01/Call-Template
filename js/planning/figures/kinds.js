/**
 * The shared vocabulary of the figures register: what kinds of figure there are,
 * which modules a figure can be used by, and which words a client-facing string
 * must never carry. Kept in one place so a catalogue, the index builder and the
 * check all agree.
 */

/**
 * `law` is in force, `announced_law` is announced or published as a Bill and not
 * yet enacted, `market` is a price or rate that moves on its own, and
 * `planeir_assumption` is Planeir's own choice, which a scheduled job never
 * changes.
 */
export const FIGURE_KINDS = Object.freeze(['law', 'announced_law', 'market', 'planeir_assumption']);

/** What a figure's value is measured in. A `rate` is a fraction: 0.02 is 2%. */
export const FIGURE_UNITS = Object.freeze([
  'rate', 'rate_a_year', 'eur', 'eur_a_week', 'eur_a_month', 'eur_a_year',
  'age', 'years', 'months', 'multiple', 'year', 'count', 'date', 'text'
]);

/** A catalogue status says whether a rule is in force or only announced. */
export function figureKindForStatus(status) {
  return status === 'announced' ? 'announced_law' : 'law';
}

/**
 * The modules a figure can be `usedBy`. These are the names the plan pack and
 * the module registry use, plus `planning` for figures the whole planning layer
 * reads and `plan_pack` for the plan layer's own narration and ledger.
 */
export const FIGURE_MODULES = Object.freeze([
  'planning',
  'plan_pack',
  'house_purchase',
  'pension_projection',
  'net_retirement_cashflow',
  'college_funding',
  'liquidity_analysis',
  'household_cash_flow',
  'future_cost_fund',
  'goals_and_resources',
  'protection_gap',
  'rental_keep_or_sell',
  'home_trade_down',
  'care_costs'
]);

/**
 * Banks and lenders whose published rates the market figures are read from.
 * They may appear in a figure's observations as internal provenance and nowhere
 * a client could see or hear: not in a label, a basis or a source title.
 */
export const PROVIDER_NAMES = Object.freeze([
  'Bank of Ireland',
  'AIB',
  'Allied Irish',
  'PTSB',
  'permanent tsb',
  'Permanent TSB',
  'Ulster Bank',
  'KBC',
  'Revolut',
  'An Post',
  'Credit Union',
  'Haven',
  'Avant',
  'Finance Ireland'
]);

/**
 * The provider name a text carries as a whole word, or null. The Central Bank of
 * Ireland is the regulator and not a lender, so its name is not one.
 */
export function namesAProvider(text) {
  if (typeof text !== 'string') return null;
  const withoutRegulator = text.replace(/Central Bank of Ireland/gi, '');
  return PROVIDER_NAMES.find((name) => new RegExp(`(^|[^A-Za-z])${name}([^A-Za-z]|$)`, 'i').test(withoutRegulator)) ?? null;
}

/**
 * Hosts an explainer may take its sources from: the State's own pages. These are
 * the Department of Social Protection and gov.ie, Revenue, Citizens Information
 * and the state money and consumer services. A host matches itself and its
 * subdomains.
 */
export const OFFICIAL_SOURCE_HOSTS = Object.freeze([
  'gov.ie',
  'revenue.ie',
  'citizensinformation.ie',
  'welfare.ie',
  'mabs.ie',
  'ccpc.ie',
  'centralbank.ie',
  'hse.ie',
  'irishstatutebook.ie',
  'oireachtas.ie'
]);

/**
 * Wording an explainer must not carry. An explainer is education: it says how a
 * rule works in the "you" voice. It types no figure (the screen fills those in
 * from the register by id), gives no advice, and speaks for nobody in the first
 * person.
 */
export const EXPLAINER_BANNED_WORDING = Object.freeze([
  Object.freeze({ name: 'a typed figure', pattern: /[0-9\u20ac\u00a3$%]|\bper ?cent\b/i }),
  Object.freeze({ name: 'advice', pattern: /\b(should|shouldn't|ought|recommend\w*|advis\w*|best|we suggest|you need to)\b/i }),
  Object.freeze({ name: 'a guarantee', pattern: /\b(guarantee\w*|definitely)\b/i }),
  Object.freeze({ name: 'the first person', pattern: /\b(we|our|ours|us)\b/i }),
  Object.freeze({ name: 'the first person', pattern: /\bI\b/ })
]);
