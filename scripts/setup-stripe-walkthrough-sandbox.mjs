import Stripe from 'stripe';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { parseEnv } from 'node:util';

// No live mutations, raw credentials or provider response bodies are printed.
const path = new URL('../worker/.dev.vars', import.meta.url);
let source = readFileSync(path, 'utf8');
const env = parseEnv(source);
if (!/^(rk|sk)_test_/.test(env.STRIPE_API_KEY || '')) throw new Error('Save a Stripe test server key in worker/.dev.vars first.');
const stripe = new Stripe(env.STRIPE_API_KEY, { httpClient: Stripe.createFetchHttpClient(), timeout: 10000, maxNetworkRetries: 2 });
try {
  const account = await stripe.accounts.retrieve();
  let price = env.STRIPE_WALKTHROUGH_PRICE_ID ? await stripe.prices.retrieve(env.STRIPE_WALKTHROUGH_PRICE_ID)
    : (await stripe.prices.list({ lookup_keys: ['planeir_walkthrough_eur_9999_v1'], limit: 1 })).data[0];
  if (!price) {
    const product = await stripe.products.create({ name: 'Planeir report walkthrough',
      description: '40-minute online personal finance education walkthrough.' }, { idempotencyKey: 'planeir-walkthrough-product-v1' });
    price = await stripe.prices.create({ product: product.id, currency: 'eur', unit_amount: 9999,
      tax_behavior: 'inclusive', lookup_key: 'planeir_walkthrough_eur_9999_v1' }, { idempotencyKey: 'planeir-walkthrough-eur-9999-v1' });
  }
  if (price.livemode !== false || !price.active || price.unit_amount !== 9999 || price.currency !== 'eur'
    || price.recurring || price.tax_behavior !== 'inclusive') throw new Error('The saved test Price does not match the walkthrough.');
  for (const [key, value] of Object.entries({ STRIPE_WALKTHROUGH_PRICE_ID: price.id, STRIPE_MODE: 'test',
    STRIPE_TAX_MODE: 'no_collection', STRIPE_WALKTHROUGHS_ENABLED: 'false' })) {
    const line = `${key}=${value}`;
    source = new RegExp(`^${key}=.*$`, 'm').test(source) ? source.replace(new RegExp(`^${key}=.*$`, 'm'), line) : `${source}\n${line}\n`;
  }
  writeFileSync(path, source); chmodSync(path, 0o600);
  console.log(JSON.stringify({ configured: true, mode: 'test', account: account.id, product: price.product,
    price: price.id, amountCents: price.unit_amount, currency: price.currency, checkoutEnabled: false }));
} catch (error) {
  console.error(JSON.stringify({ configured: false, type: error.type, code: error.code, status: error.statusCode }));
  process.exitCode = 1;
}
