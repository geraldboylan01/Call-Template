# Personalised Planéir walkthrough operations

A customer opens their completed analysis, gives Gerry permission to review that
exact report and pays **€99.99** through Stripe. Once Stripe verifies payment,
they choose a **40-minute Zoom call** at least **24 hours ahead** and can add a
few discussion topics. The app creates the meeting and emails both people. A
customer who leaves after paying can return and choose a time without paying
again. Gerry can suggest a replacement time while the original stays reserved.

Analysis remains free. This is a personal educational walkthrough with Gerry,
the creator of Planéir; it does not provide regulated financial advice or trigger
an adviser introduction. The internal pFUM/readiness pilot remains separate.

## Implementation and activation status

The paid-first purchase, signed Stripe webhooks, scheduling page, encrypted topics,
four email jobs, existing Zoom integration, protected analysis links and
administrator controls are implemented locally. **This version has not been
activated or deployed to production.** The source configuration keeps
all three payment/email activation flags false in the non-secret `WALKTHROUGH_SETTINGS_JSON` binding.
Live checkout also requires the separate `STRIPE_WALKTHROUGH_LIVE_ACTIVATED=true`
gate; an absent value keeps live collection blocked.

Local tests exercise signed synthetic Stripe events, real Worker/D1/R2 routes,
mocked Zoom/email responses, authentication and desktop/mobile screens. Earlier
test-only setup created a Product, inclusive EUR Price and Checkout Session,
retrieved/reused that Session and expired it **without attempting a payment**.
That API probe is not an end-to-end payment test. Actual Stripe-hosted test
payment, Stripe-to-deployed-Worker webhook delivery, real Zoom meeting creation
and delivery to authorised test email recipients still need staging validation.
Do not claim that those external steps have passed.

## Configuration and database

Apply the adviser database migrations through **0027** in order. In particular:

- **0021–0024** provide bookings, shared calendar conflict guards, qualification
  records and encrypted report copies. Migration 0021 imports future app
  appointments and aborts on conflicts; resolve those before rollout.
- **0025** adds Stripe orders, processed event IDs and payment guards.
- **0026_paid_first_walkthroughs.sql** lets a purchase exist before an appointment,
  preserves older Stripe orders, adds purchase lifecycle and encrypted topics,
  creates independent payment-email jobs and guards paid scheduling.
- **0027_walkthrough_customer_profiles.sql** saves encrypted contact details
  against the existing private consumer session/report identity.

Use a separate local or staging D1 database for test purchases. Reuse the existing
`LEADS_DB`, `SESSIONS_BUCKET`, adviser authentication, Resend and Zoom setup.
Do not let test payments reserve real customer appointments.

| Setting | Purpose |
| --- | --- |
| `STRIPE_API_KEY` | Server-only restricted key, or existing secret key, for the selected environment. |
| `STRIPE_MODE` | `test` or `live`; defaults to `test`. Key, Price, orders and events must agree. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret belonging to this environment's deployed event destination. |
| `STRIPE_WALKTHROUGH_PRICE_ID` | Active one-time EUR 9999-cent Price with inclusive tax behaviour. |
| `STRIPE_TAX_MODE` | `no_collection`; other values block checkout until tax support is deliberately extended. |
| `STRIPE_WALKTHROUGHS_ENABLED` | Enables new purchases/Checkout when `true`; defaults to false and is unset in production source. |
| `STRIPE_WALKTHROUGH_LIVE_ACTIVATED` | Additional explicit gate for live checkout. Keep absent/false until live activation is authorised. |
| `WALKTHROUGH_EMAILS_ENABLED` | Independent gate for walkthrough payment and booking emails; defaults to false and stays unset. Disabled queues wait without sending. |
| `EDUCATION_CALLS_ENABLED` | Existing completed-report booking feature flag. It does not override the Stripe or email activation gates. |
| `STRIPE_RETURN_ORIGIN` | Customer site's origin; defaults to `https://planeir.ie`. Local preview supports `http://127.0.0.1:8080` or `http://localhost:8080`. |
| `STRIPE_WALKTHROUGH_INVOICES_ENABLED` | Optional paid-invoice generation; off by default. Review its fees before enabling. |

The protected GitHub production variable `WALKTHROUGH_SETTINGS_JSON` supplies the six non-secret settings above as one validated JSON binding. The default contains test mode and disabled checkout/live/email gates. The deploy workflow keeps these gates off during bootstrap and restores the reviewed production values for the final deployment. Explicit individual environment bindings can override valid JSON for operational kill switches. Invalid JSON disables only the new payment/email features. Never put credentials in this setting.

A live one-time Price now exists: `price_1US0NFI0WsvOmqNb12spseM2` (€99.99 EUR, inclusive). Its webhook is `we_1US0QKI0WsvOmqNbmzqwqRK5`, targeting the endpoint below. The signing secret is stored in the existing Worker secret store; it is not committed. Live checkout still requires the matching live server key and all three activation gates.

Store Stripe API/signing secrets in the Worker's existing secret store. Keep
non-secret settings in deployment configuration. Never commit keys or send them
to the browser. The ignored local `worker/.dev.vars` is for local configuration;
`STRIPE_PUBLISHABLE_KEY` is not needed by this hosted redirect flow. Prefer a
restricted server key with Checkout Sessions read/write and the necessary
Prices, PaymentIntents and Charges read permissions, including nested expansions.
The existing test provisioning script additionally needs Products/Prices write.

Report copies, saved profile details and discussion topics use the existing
application encryption configuration (`APPLICATION_DATA_ENCRYPTION_KEY`, its key
identifier and previous-key configuration). The existing authorised email sender
and administrator recipients must be configured in Resend/Worker settings; use
`hello@planeir.ie` only through the authorised sender configuration. The existing
Zoom account, client credentials and user settings are reused. Missing settings
must be identified by name without exposing their contents.

Tax collection stays off for the merchant's confirmed initial Ireland-first,
not-VAT-registered setup. This setting is not a determination of tax liability.
Subscriptions, adviser introduction billing and new paid third-party services
are outside this implementation. Stripe account setup is being handled separately.

## Customer flow and recovery

1. The **Book a Walkthrough with Gerry** panel appears beside completed consumer
   results and unlocked published reports. It explains the €99.99 offer and asks
   for exact-report access consent and the service terms.
2. Existing saved contact details are reused. A legacy consumer session without
   a name/email must **save its profile details before checkout**, as chosen by
   the user. These are saved encrypted once against that session. Checkout does
   not request those details again or create another Planéir account. Published
   reports use their saved contact details. Consumer-confirmed contact details
   must not be described as independently verified account identity.
3. The server creates or recovers a purchase bound to the authorised source and
   exact analysis. It creates Stripe-hosted Checkout with the server-owned Price,
   EUR amount, quantity and saved email. Eligible Apple Pay, Google Pay and cards
   are displayed by Stripe; availability depends on the device and configuration.
   No appointment is reserved at this stage.
4. A signed webhook verifies the payment. A success redirect alone never grants
   scheduling. The return page waits for the server's paid state when needed.
   Unpaid asynchronous payments remain pending until Stripe reports success.
5. Paid customers choose an available time and optionally enter up to **1,000
   characters** of discussion topics. Name/email are not requested again. The
   server checks payment, consent, 24-hour notice and calendar conflicts before
   atomically recording the booking and Zoom job. A competing booking returns a
   refreshed availability choice; the paid purchase and entered topics survive.
6. Zoom details are saved before the booking emails and calendar invitation are
   sent. The customer can review their topics and private analysis link afterwards.

One active purchase per source prevents duplicate payment attempts, including when the customer reruns their analysis. The original shared report stays attached to that purchase.
Checkout retries reuse the saved Session and provider idempotency key. Paid but
unscheduled purchases remain recoverable from the authenticated source panel and
private payment-email link; browser storage is a convenience, not the only
recovery method. A completed or cancelled purchase does not prevent a later new
walkthrough purchase. Failed, disputed or otherwise uncertain payments require
review before collecting again.

The payment-return and private recovery pages use purchase/booking capabilities;
knowing an opaque purchase ID alone does not authorise access. Private tokens stay
out of Stripe metadata and return URLs, and are removed from the visible fragment
after the page captures them. Report payload keys are never stored in browser
recovery records or sent to Stripe. Stripe receives the required customer email
and opaque purchase reference, not financial reports, topics or report keys.

## Scheduling and Gerry's controls

All times follow **Europe/Dublin**, including daylight saving. The booking horizon
is **28 days** and starts are offered in **15-minute intervals**:

| Days | Window | Permitted starts |
| --- | --- | --- |
| Monday–Friday | 19:30–21:00 | 19:30, 19:45, 20:00, 20:15 |
| Saturday–Sunday | 12:00–17:00 | Every 15 minutes from 12:00 through 16:15 |

Every call lasts 40 minutes and ends inside the window, with no added buffer.
The latest calls end at 20:55 and 16:55. Both the browser and server require
`meetingStart >= now + 24 hours`, including replacement proposals and customer
acceptance of a new time. Database scheduling guards provide another backstop.

Open **Clients → Paid walkthroughs** to see purchases, payment/email states,
chronological upcoming appointments, contact details, discussion topics, Zoom
links and the two analysis views. Mark a walkthrough completed after the call.
Manual unavailable-time blocks and all app appointments share the same database
reservation checks. External calendar integration is not included; add manual
blocks for external commitments.

Gerry can propose an available replacement. The original reservation remains
until the customer accepts; the proposal hold lasts at most 24 hours, capped by
either appointment's start. Decline or expiry retains the original. Acceptance
switches reservations atomically, preserves payment and updates the existing
Zoom meeting/calendar invitation. Existing administrator controls handle
cancellation and recovery; customers use their private link to accept or decline
proposals. This version does not add a separate unrestricted self-reschedule flow.

## Four independent emails

The existing Resend delivery infrastructure sends four separately tracked jobs:

| Trigger | Recipient | Contents |
| --- | --- | --- |
| Stripe-verified payment | Customer | Personal payment acknowledgement and private scheduling/recovery link. If already booked, the message reflects that status. |
| Stripe-verified payment | Gerry | Full name/email, amount/date/reference, scheduling status and both specific analysis links. |
| Saved Zoom meeting | Customer | Confirmed date/time, actual Zoom URL, calendar invitation, private client analysis link and booking management link. |
| Saved Zoom meeting | Gerry | Contact details, date/time/duration/Zoom, encrypted-at-rest discussion topics or “No specific discussion topics provided.”, payment reference and both specific analysis links. |

Payment emails do not depend on the customer returning from Stripe or selecting
a time. Each recipient's email has its own durable job and idempotency key;
one recipient's failure does not require repeating the other's successful email.
Optional topics remain available when meeting details are resent. Financial
balances and the detailed report are not copied into email bodies.

Retries retain the original delivery identity. If a send remains ambiguous beyond
the provider's safe idempotency window, it is marked uncertain for review rather
than blindly resent. Similarly, uncertain Zoom creation requires reconciliation
with the existing Zoom meeting before another create is attempted. Retry email
without creating a new meeting. Do not promise exactly-once external delivery
when a provider's final outcome cannot be established.

## Analysis access and privacy

The customer explicitly consents to an immutable encrypted copy of the exact
analysis they purchased the walkthrough for. This permission is separate from
commercial adviser-introduction consent. Native analyses retain all completed
module results; published reports retain their original report content and assets.

Both administrator links target that customer's exact consented report:

- **Advisor analysis** uses the existing staff session plus advisor capability.
- **Client analysis** in Gerry's email opens a client-view preview with the same
  staff authentication and advisor capability. Gerry does not need the client's PIN.

The customer's own analysis link uses a client capability and the existing
six-digit PIN protection. Where the copied report has a pending PIN, the customer
creates and confirms it on first opening; later access requires it. Neither an
unauthenticated visitor nor a different customer's session can open the report
merely by knowing its identifier. Private report keys remain in URL fragments/tab
memory; no detailed financial figures are included in the emails.

The report copy stays available while a paid walkthrough awaits scheduling, then
expires 30 days after the call or cancellation. Scheduled maintenance removes the
expired report bytes, assets and recovery keys. Unpaid attempts have separate
expiry; payment/accounting records follow their applicable retention rules.
Discussion topics are stored encrypted; advise customers to avoid passwords,
account numbers or other unnecessary sensitive data. Calls are unrecorded by
default. Handle cancellation and data requests through `hello@planeir.ie`.

## Stripe event destination and payment review

Endpoint: `https://api.planeir.ie/api/stripe/webhook`; use a separate hostname and
database for the staging/test Worker. Configure snapshot events using
`2026-09-30.endive`, matching the installed SDK, and subscribe to:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`
- `charge.refunded`
- `charge.dispute.created`
- `charge.dispute.closed`

Use that destination's signing secret. The endpoint verifies the exact raw-body
signature and environment, retrieves authoritative Stripe state and checks
purchase reference, Session/payment identity, Price, quantity, EUR amount and
successful payment status. It rejects oversized bodies and stale signatures;
raw event bodies are not retained. Processed event IDs and payment transitions
are durable and transactional. Duplicate events cannot create another purchase,
booking, meeting or email job. Retryable processing failures remain retryable.

Stopping new checkout does **not** disable outstanding signed-payment processing.
Keep the matching key, webhook secret and database available during rollback.

Refunds are completed against the original payment in the Stripe Dashboard; the
app does not initiate a refund or charge a saved payment method. Refund/dispute
events create visible review states; a full refund marks the payment refunded.
Review suppresses future queued fulfilment but cannot undo an already created
meeting or delivered email. Cancel/reconcile those in the existing panel.
Partial refunds and dispute outcomes require operator review. A late payment on
an older reserved-first booking cannot revive an expired or cancelled time.
Historical manual Revolut bookings retain their original payment controls and
offer terms; they are not converted to a second charge.

## Validation and release

The local commands are:

```sh
npm run check:stripe
npm run check:stripe-ui
npm run check:education-booking
npm run check:education-booking-ui
npm run check:workspace-browser
npm run check:lead-qualification
npm run check:workspace-copy
npm run check:deploy-canary-config
npm run build
```

`check:stripe` includes signed synthetic event tests and the paid-first Worker
integration suite. The browser suites cover desktop/mobile and use `CHROME_PATH`
when Chrome is elsewhere. The existing `setup:stripe-sandbox` and
`probe:stripe-sandbox` scripts only support test credentials; setup/probe alone
does not validate the new end-to-end purchase. Do not create a replacement
Stripe account or repeat onboarding; the user is configuring that separately.

Before any live activation:

1. Apply all migrations to an isolated staging database and deploy a test Worker
   and customer pages with matching Stripe test configuration.
2. Complete a real hosted test payment and verify actual signed webhook delivery,
   paid-but-unscheduled recovery and duplicate-event handling.
3. Book a time at least 24 hours ahead; verify real Zoom creation and each of the
   four emails using authorised test recipients. Open the exact advisor view,
   staff client preview and customer's PIN-protected link. Verify mobile use,
   conflicts, rescheduling, cancellation/refund review and failure recovery.
4. Confirm the live Price, environment-specific secrets, existing authorised
   sender/recipient settings and Zoom permissions, without exposing secret values.
5. Report the results and obtain the user's explicit activation authorisation.
   Only then enable the live checkout and walkthrough email gates deliberately.

Until those steps are complete, keep live collection and customer-facing emails
off. No production deployment or completed real Stripe webhook/payment exercise
is asserted by this document.

See [the historical reserve-first Stripe plan](stripe-integration-plan.md),
[historical Revolut operations](paid-walkthrough-operations.md) and
[the internal qualification methodology](lead-qualification-methodology.md).
