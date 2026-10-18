import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createTestRuntime } from './lib/application-test-runtime.mjs';
import { createWalkthroughCheckout, stripeClient } from '../worker/src/stripe_walkthroughs.js';

// Uses synthetic local booking data and the saved test key. Never runs in live
// mode, sends customer data, confirms a charge, or calls Zoom/email providers.
const saved = parseEnv(readFileSync(new URL('../worker/.dev.vars', import.meta.url), 'utf8'));
assert.match(saved.STRIPE_API_KEY || '', /^(rk|sk)_test_/);
const runtime = createTestRuntime({ ...saved, STRIPE_MODE: 'test', STRIPE_WALKTHROUGHS_ENABLED: 'true',
  STRIPE_WEBHOOK_SECRET: 'whsec_local_probe_only', STRIPE_TAX_MODE: 'no_collection' });
const { env, sql } = runtime;
let sessionId;
try {
  const id = randomUUID(), time = Math.floor(Date.now() / 1000), start = time + 3 * 86400;
  sql.prepare(`INSERT INTO education_bookings (id, source_type, source_id, idempotency_key, request_digest,
    access_token, created_at, updated_at, status, setup_state, full_name, email, start_at, end_at, hold_expires_at,
    amount_cents, currency, offer_version, offer_json, consent_json)
    VALUES (?, 'published', ?, ?, 'synthetic', 'local-only-synthetic-token', ?, ?, 'awaiting_payment', 'ready',
      'Synthetic Test', 'synthetic@example.com', ?, ?, ?, 9999, 'EUR', 'private-education-call-v2', '{}', '{}')`)
    .run(id, id, id, time, time, start, start + 2400, time + 86400);
  sql.prepare(`INSERT INTO education_calendar_reservations (id, booking_id, kind, start_at, end_at, expires_at)
    VALUES (?, ?, 'booking', ?, ?, ?)`).run(id, id, start, start + 2400, time + 86400);
  const booking = sql.prepare('SELECT * FROM education_bookings WHERE id = ?').get(id);
  const created = await createWalkthroughCheckout(env, booking);
  sessionId = sql.prepare('SELECT session_id FROM education_stripe_orders WHERE booking_id = ?').get(id).session_id;
  const repeated = await createWalkthroughCheckout(env, booking);
  assert.equal(created.checkoutUrl, repeated.checkoutUrl);
  const session = await stripeClient(env).checkout.sessions.retrieve(sessionId, { expand: ['line_items'] });
  assert.equal(session.livemode, false); assert.equal(session.amount_total, 9999);
  assert.equal(session.currency, 'eur'); assert.equal(session.automatic_tax.enabled, false);
  assert.equal(session.line_items.data[0].quantity, 1);
  console.log(JSON.stringify({ passed: true, mode: 'test', session: session.id, amountCents: session.amount_total,
    currency: session.currency, duplicateCreationReusedSession: true, automaticTax: false }));
} catch (error) {
  console.error(JSON.stringify({ passed: false, type: error.type || error.name, code: error.code, status: error.statusCode,
    assertion: error.name === 'AssertionError' ? error.message : undefined }));
  process.exitCode = 1;
} finally {
  if (sessionId) {
    try { await stripeClient(env).checkout.sessions.expire(sessionId); console.log('Synthetic Checkout Session expired after the check.'); }
    catch { console.log('Synthetic Checkout Session will expire automatically; no payment was attempted.'); }
  }
  runtime.close();
}
