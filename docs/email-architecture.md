# Planeir Email Architecture

Planeir uses `hello@planeir.ie` as its public contact address.

Outbound and inbound email are separate concerns:

- Outbound sending already works through the existing Cloudflare Worker and Resend configuration. Do not replace or remove `RESEND_API_KEY`, `LEAD_EMAIL_FROM`, `SESSION_EMAIL_FROM`, SPF, DKIM, DMARC, or any existing Worker email logic just to add inbound delivery.
- Inbound email to `hello@planeir.ie` should be forwarded to `geraldboylan@gmail.com`.
- Cloudflare Email Routing is the simplest free fit for inbound forwarding while `planeir.ie` is managed in Cloudflare DNS.
- Cloudflare Email Routing is not a mailbox. It forwards received mail to a destination inbox and does not replace the existing outbound Resend setup.
- Replying from Gmail as `hello@planeir.ie` is separate from inbound forwarding. It may require Gmail send-as SMTP setup, a Resend-compatible SMTP path, or a proper mailbox provider later.

## Current Repo Setup

The public landing page already shows the public address:

- `index.html` includes `mailto:hello@planeir.ie` in the open contact card.
- `index.html` includes `mailto:hello@planeir.ie` in the footer.

The Worker already sends outbound email with Resend:

- Lead capture notifications use `RESEND_API_KEY`, `LEAD_EMAIL_FROM`, `LEAD_NOTIFICATION_TO`, `LEAD_REPLY_TO`, and `LEAD_CONFIRMATION_EMAIL_ENABLED`.
- Published-session emails use `RESEND_API_KEY`, `SESSION_EMAIL_FROM`, `SESSION_EMAIL_REPLY_TO`, and `SESSION_ADVISOR_NOTIFICATION_TO`.
- `SESSION_EMAIL_FROM` falls back to `LEAD_EMAIL_FROM` when it is not set.

No frontend code should contain `geraldboylan@gmail.com` as the inbound recipient. Internal notification recipients belong in Worker environment variables such as `LEAD_NOTIFICATION_TO` or `SESSION_ADVISOR_NOTIFICATION_TO`.

## Cloudflare Email Routing Setup

Configure this outside the codebase in Cloudflare:

1. Open the Cloudflare dashboard for `planeir.ie`.
2. Go to Email Routing.
3. Add `geraldboylan@gmail.com` as a destination address.
4. Complete the Cloudflare verification email sent to `geraldboylan@gmail.com`.
5. Create a custom address rule:
   - Custom address: `hello@planeir.ie`
   - Destination: `geraldboylan@gmail.com`
6. Let Cloudflare add the required Email Routing DNS records when prompted.
7. Preserve the existing outbound records used by Resend, including SPF, DKIM, and DMARC records. If Cloudflare asks to change DNS, review the exact records first and avoid deleting Resend verification records. If a root SPF TXT record already exists, do not leave a second root SPF record in place; merge the needed Cloudflare include into the existing SPF policy instead.

Cloudflare Email Routing requires the domain's MX records to point at Cloudflare's mail exchangers. If another inbound mail provider is already configured with MX records, Cloudflare will not enable routing until that conflict is resolved. That does not require changing the public sender address or removing Resend's outbound configuration.

## Testing

After the dashboard setup is complete:

1. Send a test email to `hello@planeir.ie` from an address other than `geraldboylan@gmail.com`.
2. Confirm the message arrives in the `geraldboylan@gmail.com` inbox.
3. Check Gmail spam/promotions if it does not appear in the inbox.
4. In Cloudflare Email Routing, confirm the route is enabled and the destination address is verified.
5. Keep testing outbound separately by submitting the existing landing-page form or sending a published-session email through the app. Those paths should continue to send from the configured Resend sender.

Do not test by sending from `geraldboylan@gmail.com` to `hello@planeir.ie`; Gmail may hide the forwarded copy as a duplicate.
