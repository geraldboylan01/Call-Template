/**
 * The shared vocabulary of the figures register: what kinds of figure there are,
 * which modules a figure can be used by, and which words a client-facing string
 * must never carry. Kept in one place so a catalogue, the index builder and the
 * check all agree.
 */

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
  'home_trade_down'
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

/** True when `text` contains a provider name as a whole word. */
export function namesAProvider(text) {
  if (typeof text !== 'string') return null;
  return PROVIDER_NAMES.find((name) => new RegExp(`(^|[^A-Za-z])${name}([^A-Za-z]|$)`, 'i').test(text)) ?? null;
}
