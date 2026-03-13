# Planeir

Planeir now ships as two connected experiences:

- `/` is the public landing page for first-time visitors.
- `/app/` is the existing advisor workspace.
- `/app/session.html?id=...` is the client session viewer used by published links.
- `/session.html?id=...` remains as a compatibility redirect to `/app/session.html?id=...`.

## Local Development

Static site:

1. Serve the repo with any static server.
2. Open `/` for the landing page.
3. Open `/app/` for the advisor app.

Worker:

1. From `worker/`, run the Cloudflare Worker locally with Wrangler.
2. The static site will use `http://127.0.0.1:8787` automatically on `localhost` / `127.0.0.1`.
3. Apply the D1 migrations before testing lead capture:

```bash
cd worker
npx wrangler d1 migrations apply planeir-leads --local
```

## Lead Capture

The landing page form posts to the existing Cloudflare Worker:

- Endpoint: `POST /api/leads`
- Storage: the `LEADS_DB` D1 binding, table `leads`
- Stored columns: `created_at`, `full_name`, `email`, `phone`, `help_reason`, `stage`, `call_outcome`, `consent_free_call`, `consent_recording`, `source`
- Migration files: `worker/migrations/0001_create_leads.sql`, `worker/migrations/0002_add_call_outcome_to_leads.sql`
- Email notifications: Resend API is called from the Worker after a successful D1 insert

### Lead Email Configuration

The Worker sends a non-blocking internal notification email after a lead is stored successfully. An optional submitter confirmation email can also be enabled.

Recommended configuration:

- Secret: `RESEND_API_KEY`
- Variable or secret: `LEAD_EMAIL_FROM`
- Variable or secret: `LEAD_NOTIFICATION_TO`
- Optional variable or secret: `LEAD_REPLY_TO`
- Optional variable or secret: `LEAD_CONFIRMATION_EMAIL_ENABLED`

Example setup:

```bash
cd worker
wrangler secret put RESEND_API_KEY
wrangler secret put LEAD_EMAIL_FROM
wrangler secret put LEAD_NOTIFICATION_TO
wrangler secret put LEAD_REPLY_TO
```

For the optional confirmation email toggle, set `LEAD_CONFIRMATION_EMAIL_ENABLED=true` in the Cloudflare dashboard or in local Wrangler development variables.

Notes:

- `LEAD_EMAIL_FROM` must be a sender address verified with Resend, for example `Planeir <hello@yourdomain.com>`.
- `LEAD_NOTIFICATION_TO` can be Gerry's email address or a comma-separated list of internal recipients.
- The internal notification uses the submitter's email as `Reply-To`, so Gerry can reply directly.
- `LEAD_REPLY_TO` is only used on the optional confirmation email.
- If email delivery fails or email is not configured, the lead is still stored and the API still returns success.

Apply the remote migration with:

```bash
cd worker
npx wrangler d1 migrations apply planeir-leads --remote
```

## Published Client Sessions

Published session payloads still use the existing Worker and R2 bucket:

- `POST /api/publish`
- `GET /api/session/:id`
- `POST /api/revoke/:id`

When the advisor app is served from `/app/`, generated client links now resolve to `/app/session.html?id=...`.

## Build For GitHub Pages

Run:

```bash
npm run build
```

The build step:

- copies static assets into `dist/`
- versions relative asset URLs in HTML
- emits `dist/index.html`
- emits `dist/app/index.html`
- emits `dist/app/session.html`
- emits the root compatibility redirect at `dist/session.html`
- copies `CNAME` into `dist/`

GitHub Pages must publish from `GitHub Actions`, not from the branch root or `/docs`.
The workflow in [`.github/workflows/deploy-pages.yml`](/Users/geraldboylan/Documents/GitHub/Call-Template/.github/workflows/deploy-pages.yml)
deploys only `dist/`, and production should therefore serve HTML that includes `?v=<commit-sha>` on local CSS, JS, and image assets.

If the live site is serving unversioned asset URLs, Pages is publishing the wrong source and browsers can mix fresh HTML with stale CSS/JS caches.

The deploy workflow now includes a smoke check that fetches `/` and `/app/` from the live origin and fails unless the deployed HTML contains the expected versioned asset URLs for the current commit.

## Testing Lead Notifications

1. Configure the email variables above in the Worker environment.
2. Run the Worker locally from `worker/`.
3. Submit the landing-page form against the local Worker.
4. Confirm the lead row was inserted into D1.
5. Confirm Gerry receives the internal notification email.
6. If `LEAD_CONFIRMATION_EMAIL_ENABLED=true`, confirm the submitter receives the acknowledgement email.
7. To test failure handling, temporarily remove `RESEND_API_KEY` or use an invalid key, submit again, and confirm the API still returns success while the Worker logs the email failure.

## File Structure

- `index.html` public landing page
- `app/index.html` advisor app
- `app/session.html` client viewer
- `session.html` compatibility redirect for older links
- `dist/` the only GitHub Pages deploy artifact
- `styles/landing.css` landing page styling
- `styles/base.css` advisor app styling
- `js/landing.js` landing page interactions and lead form submission
- `js/app.js` advisor app logic
- `js/session_viewer.js` client viewer logic
- `scripts/check-pages-versioned-assets.sh` post-deploy verification for the live Pages site
- `worker/src/index.js` Worker API for sessions and leads
