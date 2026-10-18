# Planeir Stripe integration plan

> **Superseded implementation plan.** This document records the original
> reserve-a-time-before-paying design. The current implementation follows the
> user's later request: Stripe payment first, then appointment selection with
> 24 hours’ notice. Use [current walkthrough operations](stripe-walkthrough-operations.md)
> for migrations, saved profiles, activation gates, emails and release checks.
> References below to a provisional slot hold describe the historical plan.


Prepared 18 October 2026 using the Stripe plugin's implementation planner.
Planner guide: `iguide_61VbJFIOL8ZfEeKXE41I0WsvOmqNb`.
The accepted integration shape is Stripe-hosted web Checkout. The machine-readable
planner result and documentation links are in `stripe-planner-result.json`.

## Confirmed scope

- Start with the existing optional 40-minute educational report walkthrough at
  **€99.99 total**, replacing its manual Revolut Pro collection process.
- The underlying analysis stays free. No adviser referral fees or distribution
  are introduced by this integration.
- Planeir says it is not VAT-registered and will initially sell in Ireland.
  Leave automatic tax collection off. This records the merchant's current
  instruction; it is not a determination of VAT liability or education exemption.
- Billing is a later phase: no subscription price or paid entitlement has been
  defined. Do not create an invented recurring offer.

## Current checkout review

At the start of this work there was no Stripe integration. Existing bookings are managed in
`worker/src/education_calls.js`; delivery hooks are in
`worker/src/education_call_integration.js`. Current operations are described in
`docs/paid-walkthrough-operations.md`.

The existing flow reserves a slot for up to 24 hours, capped by the appointment
start, sends a manual Revolut Pro payment request, and requires an administrator
to verify payment. It already has calendar conflict guards, booking revisions,
unique payment references, late-payment review and a durable Zoom/email outbox.
Reuse those protections when adding Stripe. The current payment-link validator,
email wording and administrator controls explicitly assume Revolut; adding a
Stripe link alone would leave verification and customer messaging inconsistent.

## Payments: the first implementation

1. Create a Product and a one-time EUR Price for 9999 cents in a **development
   sandbox**. Keep the advertised total inclusive of any future applicable tax;
   confirm the product tax classification before enabling collection. Pin the
   server's allowed Price ID. The browser must never choose an amount or an
   arbitrary Price.
2. Add an authenticated POST checkout action to an existing booking. Require the
   booking's private access token, a ready report snapshot, pending payment and
   an active slot hold. Avoid a simultaneous manual payment request for the same
   booking. Use the existing origin and rate-limit controls.
3. Persist a checkout attempt and its immutable parameters before calling Stripe.
   Use its opaque ID as the Stripe idempotency key and reuse the resulting
   Session on retries. Avoid issuing another collectible checkout for an order
   that is already paid or still processing.
4. Use `checkout.sessions.create` in `payment` mode and redirect to the returned
   hosted URL. Use dynamic payment methods and Link; omit `payment_method_types`.
   Include a stable integration identifier ending in eight random letters.
   Start with EUR settlement and reconciliation; assess Adaptive Pricing
   separately before allowing converted totals into exact-EUR verification.
5. Set Session expiration to respect the booking hold. Checkout's minimum
   expiration window must be checked against the remaining hold. Refuse a new
   checkout when the appointment/hold is too close; do not lengthen its slot hold
   silently to accommodate a payment.
6. Pass only an opaque order reference to Stripe metadata. Never send financial
   reports, balances, scenario inputs, report decryption keys, booking access
   tokens or private report URLs. Use a public payment-return page; keep private
   booking recovery in the browser or the existing customer email.

Use the official Stripe SDK (installed: `stripe@23.0.0`, default API version
`2026-09-30.endive`). Instantiate a client with fetch transport for Workers.
Keep its API key server-side. Hosted redirect Checkout does not require a
publishable key in the browser.

## Webhooks and booking fulfilment

Webhooks are required. Add a dedicated Stripe endpoint that accepts server
requests without browser Origin/CSRF authentication and verifies the
`Stripe-Signature` against the exact raw body using the SDK's async Web Crypto
verifier. Keep the endpoint signing secret separate from the API key.

- Handle `checkout.session.completed` and
  `checkout.session.async_payment_succeeded`. A completed Session with unpaid
  payment status must not confirm a call. Record asynchronous failure/expiry
  without treating either as a successful charge.
- Retrieve authoritative Stripe payment state, bind it to the persisted attempt,
  and check account/environment, Price, quantity, payment status, currency and
  gross total. An invoice receipt or a browser success redirect is not proof.
- Apply payment verification and calendar confirmation with the existing D1
  transaction/revision guards. Record processed event IDs durably. Both duplicate
  event IDs and separate events describing the same payment must be harmless.
- Commit payment/booking state before queueing the existing Zoom and email
  delivery jobs. Retried webhooks must not create duplicate meetings or emails.
- A payment received after cancellation, expiration or loss of the slot belongs
  in refund/rebooking review. It must never revive a reservation.
- Reconcile refunds and disputes, including out-of-order events. Expose a review
  state to the administrator; do not silently treat a refunded payment as valid.
  A refund API request is not completed until Stripe reports success.
- Return success only after durable processing or durable queue acceptance.
  Retryable failures must remain retryable. Store minimal identifiers and states,
  not raw webhook payloads containing personal data.

## Invoicing

For the initial walkthrough, consider Checkout's paid-invoice generation
(`invoice_creation.enabled`) when a downloadable invoice is needed. Confirm
Invoicing pricing and invoice presentation before enabling it. A receipt may be
sufficient for some customers; do not generate two collectible invoices for the
same walkthrough.

If a customer needs an invoice before payment, use a separate authenticated
Invoicing workflow with a Hosted Invoice Page. Tie it to the same order and slot
hold and prevent an existing Checkout Session from collecting a second payment.
Handle invoice payment/failure/void/credit-note reconciliation through webhooks.
Do not email invoices or charge saved payment methods without the appropriate
customer request and workflow authorization.

## Billing, later

Once an actual subscription offer is defined, use recurring Prices, Checkout in
`subscription` mode, flexible billing mode and the Stripe Customer Portal. Map
authenticated users to server-owned Customer IDs. Define entitlement rules for
paid, trial, past-due, unpaid and cancelled states; handle invoice payments,
subscription changes/deletions, retries and failed renewals. Never grant ongoing
access solely because a customer returns from Checkout. Keep free analysis free
unless the business explicitly changes that offer.

## Tax

Keep `automatic_tax` off for the confirmed initial setup. Do not apply a guessed
VAT rate or classify educational services as exempt solely from their name.
Review registration obligations and classification with the business's tax
adviser as the service and selling markets change.

Before enabling Stripe Tax collection, read Tax Settings, confirm the relevant
active registrations, confirm a product tax code and inclusive Price behaviour,
and run a sandbox calculation with a representative customer address. Inspect
`taxability_reason`; a zero result alone does not prove correct configuration.
Recording a registration in Stripe does not register the business with Revenue.
Sandbox registrations/settings are separate from live ones. Threshold monitoring
uses live transactions and does not establish legal registration obligations.

## Credentials and rollout

The Stripe plugin can access Planeir's live account through OAuth. That connection
does not provide an application API key. A separately added Codex MCP endpoint
exists at `https://mcp.stripe.com`; its additional CLI OAuth attempt timed out.
The plugin connection and planner worked without that separate login.

The ignored local file `worker/.dev.vars` holds the user's saved test credentials
in `STRIPE_PUBLISHABLE_KEY` and `STRIPE_API_KEY`. Both keys are test-mode keys,
and the server key authenticated successfully. Prefer a restricted
server key. Never paste keys in chat, browser code or committed configuration.
Use separate sandboxes for development and CI. Configure production keys through
the existing deployment's secret manager, with a separate webhook signing secret.

The first implementation is complete locally: a private booking Checkout action,
signed webhook receiver, durable idempotent payment/booking transition, customer
payment/return screens and administrator refund/dispute review. Test Product and
Price setup succeeded. A real Stripe test Session was created, retrieved, reused
and expired without attempting a payment. Synthetic signed webhook and browser
checks pass. Actual hosted payment and remote webhook delivery need a deployed
test destination before activation. No live resources or production deployment
were changed. Production remains on its existing payment flow.

See [Stripe walkthrough operations](stripe-walkthrough-operations.md) for the
exact environment settings, event types, tests and rollout steps.

Before release, test successful and declined payments, authentication, abandoned
checkout, duplicate creation requests, invalid/stale signatures, replayed and
out-of-order events, database/provider failures, expired/cancelled holds, delayed
payments, refunds and Zoom/email retries. Test both the booking UI and Worker
routes, then deploy behind a payment-specific feature flag. Activate live mode
only after sandbox acceptance, live account readiness and secret configuration.

Primary references: [hosted Checkout](https://docs.stripe.com/checkout/quickstart),
[fulfilment](https://docs.stripe.com/checkout/fulfillment),
[webhooks](https://docs.stripe.com/webhooks),
[post-payment invoices](https://docs.stripe.com/payments/checkout/post-payment-invoices),
[Billing](https://docs.stripe.com/billing/subscriptions/build-subscriptions),
[Tax setup](https://docs.stripe.com/tax/set-up),
[MCP](https://docs.stripe.com/mcp).
