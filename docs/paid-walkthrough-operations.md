# Paid report walkthroughs

> **Historical manual Revolut pilot.** These instructions apply to existing
> manual-payment bookings and their original offer terms. New walkthroughs use
> the paid-first Stripe implementation described in
> [current walkthrough operations](stripe-walkthrough-operations.md).
> The production state must be checked separately: the new Stripe and email
> activation gates remain off until testing and explicit user authorisation.

The consumer's analysis stays free. The optional walkthrough is €99.99 in total
for 40 minutes on Zoom. All advertised times are Europe/Dublin, including summer
time: weekdays 19:30–21:00 and weekends 12:00–17:00. Starts are offered every
15 minutes, so the last starts are 20:15 and 16:15. The booking horizon is 28 days.

## Gerry's workflow

1. Open the existing **Clients** screen and its **Paid walkthroughs** panel.
2. A customer selects a slot beside their completed results. The time is held for
   24 hours, capped at its start, and the request appears in the pipeline. The
   receipt email is provisional: no Zoom meeting is created before payment.
3. Create a request-specific payment link or invoice in Revolut **Pro** for
   €99.99. Paste its hosted HTTPS link into the booking and send payment
   instructions. Do not use a personal money transfer request in place of a Pro
   sale. Payment acceptance must be activated for the accurate service category.
4. Check the successful payment in Revolut. Enter its transaction reference and
   confirm the gross amount and EUR currency in **Verify payment received**.
   Payment fees reduce settlement; the customer must still have paid €99.99.
5. The app creates an unrecorded Zoom meeting and emails the final confirmation
   and calendar invitation. Open the consented report copy to prepare.

Selecting a slot accepts it. Only a replacement proposed by Gerry requires an
additional customer acceptance. The original time remains reserved until then.
Payments are retained across rescheduling. Use the same panel to block unavailable
periods, cancel a call, record a completed Revolut refund or retry failed delivery.
External personal-calendar events are not checked; add manual blocks for them.

An expired or cancelled slot cannot be revived by verifying a late payment. The
payment is recorded for refund or rebooking review. Complete refunds in Revolut
through the original transaction and then record the refund reference in the app.

## Recovery and privacy

Email failures retry through a durable outbox without creating another Zoom
meeting. If Zoom creation timed out, the app does not assume failure or issue
another create request. Check Zoom for the existing meeting and use the
reconciliation controls to record its ID and join URL. A failed update to an
existing meeting is retryable.

The customer explicitly shares the exact completed report with Gerry for the
walkthrough. This permission is separate from an adviser introduction. Financial
reports and recovery keys are encrypted. Report keys never appear in payment
links, audit events or booking emails. The report copy expires 30 days after the
call or closure; scheduled maintenance removes report bytes and recovery keys.
Payment and accounting records are separate. Handle cancellation and data-rights
requests at hello@planeir.ie. Calls explain assumptions and calculations and do
not include product recommendations.

## Historical deployment settings

The settings below describe the original manual pilot, not the release procedure
for the current paid-first Stripe implementation. Use the linked current guide
for migrations through 0027 and the separate payment/email activation gates.


Apply adviser database migrations **0021–0024** before enabling booking. Migration
0021 imports future app appointments and deliberately aborts if they overlap.
Resolve those appointments first; do not delete or weaken the conflict triggers.

`EDUCATION_CALLS_ENABLED` is the independent kill switch. It is enabled in the
production source config and disabled in the infrastructure-bootstrap config.
It does not activate commercial adviser handoffs. Disabling new booking retains
existing customers' private booking access and the administrator controls.

Reuse existing `LEADS_DB`, `SESSIONS_BUCKET`, adviser authentication, Resend and
Zoom configuration. No Revolut API key or Business/Merchant API is required for
this hosted-link pilot. The qualification API uses a dedicated
`QUALIFICATION_DATA_ENCRYPTION_KEY` if supplied, otherwise the existing application
data encryption key. Never put either key into source or browser configuration.

Run:

```sh
npm run check:education-call
npm run check:education-booking
npm run check:education-booking-ui
npm run check:lead-qualification
npm run check:workspace-copy
npm run check:deploy-canary-config
npm run build
```

The browser suite requires Chrome, using `CHROME_PATH` when it is not installed at
the default macOS location. Deployment workflows run the server checks before
upload. Confirm the published booking CTA and both new report/status pages after
deployment. Use a real consenting pilot customer for a real Revolut transaction;
automated tests use synthetic provider responses and never move money.

## pFUM in plain English

First count the money that could actually become new managed assets within a
year, after protecting reserves and other commitments. Unknown amounts stay
unassessed. Separately, score the person's confirmed choice to engage with a
suitable adviser. The asset total sets the test price band; demonstrated
readiness determines Standard or Priority. A paid educational walkthrough earns
no adviser-readiness points. The score is not a conversion probability, and this
version does not distribute profiles or charge advisers automatically.

See [the qualification methodology](lead-qualification-methodology.md) for the
asset ledger, weights, fee bands and observed-outcome tracking.
