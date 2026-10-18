// A single non-secret binding preserves the Workers binding allowance. These
// settings are expanded only at the Worker entry points; no credential belongs
// in this JSON. Ordinary explicit bindings retain operational override priority.
const DEFAULT_WALKTHROUGH_SETTINGS = Object.freeze({
  STRIPE_MODE: 'test',
  STRIPE_TAX_MODE: 'no_collection',
  STRIPE_WALKTHROUGH_PRICE_ID: '',
  STRIPE_WALKTHROUGHS_ENABLED: 'false',
  STRIPE_WALKTHROUGH_LIVE_ACTIVATED: 'false',
  WALKTHROUGH_EMAILS_ENABLED: 'false'
});
const gates = ['STRIPE_WALKTHROUGHS_ENABLED', 'STRIPE_WALKTHROUGH_LIVE_ACTIVATED', 'WALKTHROUGH_EMAILS_ENABLED'];
const allowed = new Set(Object.keys(DEFAULT_WALKTHROUGH_SETTINGS));

export function parseWalkthroughSettings(raw) {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > 4096) throw new Error('Invalid walkthrough settings.');
  let supplied;
  try { supplied = JSON.parse(raw); } catch { throw new Error('Invalid walkthrough settings.'); }
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)
    || Object.entries(supplied).some(([name, value]) => !allowed.has(name) || typeof value !== 'string')) {
    throw new Error('Invalid walkthrough settings.');
  }
  const settings = { ...DEFAULT_WALKTHROUGH_SETTINGS, ...supplied };
  if (!['test', 'live'].includes(settings.STRIPE_MODE)
    || settings.STRIPE_TAX_MODE !== 'no_collection'
    || !/^(?:|price_[A-Za-z0-9]+)$/.test(settings.STRIPE_WALKTHROUGH_PRICE_ID)
    || gates.some(name => !['true', 'false'].includes(settings[name]))
    || (settings.STRIPE_WALKTHROUGHS_ENABLED === 'true' && !settings.STRIPE_WALKTHROUGH_PRICE_ID)) {
    throw new Error('Invalid walkthrough settings.');
  }
  return settings;
}

export function expandWalkthroughSettings(env) {
  if (env.WALKTHROUGH_SETTINGS_JSON === undefined) return env;
  try {
    return { ...parseWalkthroughSettings(env.WALKTHROUGH_SETTINGS_JSON), ...env };
  } catch {
    // A malformed payment setting must not take the rest of the app down or
    // enable checkout/email through an explicit binding that bypasses the JSON.
    return { ...env, ...Object.fromEntries(gates.map(name => [name, 'false'])) };
  }
}
