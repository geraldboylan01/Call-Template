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
- Stored columns: `created_at`, `full_name`, `email`, `phone`, `help_reason`, `stage`, `call_outcome`, `consent_free_call`, `consent_education_only`, `consent_recording`, `source`
- Migration files: `worker/migrations/0001_create_leads.sql`, `worker/migrations/0002_add_call_outcome_to_leads.sql`, `worker/migrations/0008_add_education_only_consent_to_leads.sql`
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

### Published Session Email Configuration

Published sessions now support two separate email paths through the same Resend-backed Worker setup:

- the client-facing final email, triggered automatically from the publish modal when a client email is entered
- an automatic advisor notification email, triggered immediately after a successful publish

Recommended configuration:

- Secret: `RESEND_API_KEY`
- Variable or secret: `SESSION_EMAIL_FROM`
- Optional variable or secret: `SESSION_EMAIL_REPLY_TO`
- Variable or secret: `SESSION_ADVISOR_NOTIFICATION_TO`

Notes:

- `SESSION_ADVISOR_NOTIFICATION_TO` should point to Gerry's inbox. The default implementation target is `geraldboylan@gmail.com`.
- If `SESSION_EMAIL_FROM` is not set, the Worker falls back to `LEAD_EMAIL_FROM`.
- The advisor notification is non-blocking. If email delivery fails or email is not configured, publish still succeeds and the Worker only logs the failure.
- The advisor notification includes the client name, advisor reopen link, client link when provided, published timestamp, expiry, published session id, and the current client PIN flow summary.
- When a client email is entered, `Publish Secure Links` now publishes and immediately sends the client-facing final email.
- Ongoing resend, recovery, reset, revoke, and expiry-management flows now live on `/app/access.html`.
- Sessions published after the recovery-storage update can be searched and recovered from the Client Access page without needing the original advisor reopen link.

Example setup:

```bash
cd worker
wrangler secret put RESEND_API_KEY
wrangler secret put SESSION_EMAIL_FROM
wrangler secret put SESSION_EMAIL_REPLY_TO
```

Set `SESSION_ADVISOR_NOTIFICATION_TO=geraldboylan@gmail.com` in Wrangler vars, the Cloudflare dashboard, or local Wrangler development variables.

### Client Google Review Prompt

The client session viewer can show an optional Google review prompt after the secure link is verified and before the session opens. Configure it by setting the `planeir-google-review-url` meta tag in `app/session.html` to the direct Google Business Profile "Get more reviews" URL.

If the meta tag is empty, the prompt is skipped. The prompt opens Google in a new tab and does not collect private Planeir ratings or notes.

Because Planeir is currently online-only and education-only, it may not be eligible for a Google Business Profile under Google's current rules unless the operating model changes to include eligible in-person customer contact or a valid service-area setup.

## Organic SEO

The public homepage is positioned as Irish financial education, not regulated financial advice. The static build publishes:

- `robots.txt` with a sitemap reference
- `sitemap.xml` containing only `https://planeir.ie/`
- canonical, Open Graph, Twitter, and JSON-LD metadata on `/`
- `noindex, nofollow` metadata on `/app/`, `/app/session.html`, `/app/access.html`, and `/session.html`
- `assets/brand/planeir-social-card.png` for social previews

The public contact address is `hello@planeir.ie`. Configure this through Cloudflare Email Routing and forward it to Gerry's real inbox.

After deployment, add `planeir.ie` to Google Search Console with DNS verification, submit `https://planeir.ie/sitemap.xml`, inspect `https://planeir.ie/`, run a live test, and request indexing.

## Build For GitHub Pages

Run:

```bash
npm run build
```

The build step:

- copies static assets into `dist/`
- copies `robots.txt` and `sitemap.xml` into `dist/`
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

## Testing Published Session Emails

1. Configure `RESEND_API_KEY`, `SESSION_EMAIL_FROM`, and `SESSION_ADVISOR_NOTIFICATION_TO` for the Worker.
2. Run the static site and the Worker locally, or deploy the Worker with those variables set.
3. Open `/app/`, publish a client session, and confirm the publish succeeds without exposing the old link-management panel in the publish modal.
4. Confirm the advisor notification email arrives at `geraldboylan@gmail.com` with the advisor reopen link, client name, publish time, expiry, and published session id.
5. Open `/app/access.html`, search for the published client, and confirm the recovered client link and advisor reopen link are available there.
6. From `/app/access.html`, resend the final email, extend expiry, and reset client access, confirming each action updates the selected record.
7. To test failure handling, temporarily remove `RESEND_API_KEY` or set an invalid key, publish again, and confirm the publish still succeeds while the Worker logs the advisor notification failure instead of breaking the UI.

## File Structure

- `index.html` public landing page
- `app/index.html` advisor app
- `app/access.html` advisor-only client access manager
- `app/session.html` client viewer
- `session.html` compatibility redirect for older links
- `dist/` the only GitHub Pages deploy artifact
- `docs/prompt-pack/` zero-token ChatGPT project prompt pack, including the assembled `MASTER_PROJECT_PROMPT.md`
- `styles/landing.css` landing page styling
- `styles/base.css` advisor app styling
- `js/landing.js` landing page interactions and lead form submission
- `js/app.js` advisor app logic
- `js/session_viewer.js` client viewer logic
- `scripts/check-pages-versioned-assets.sh` post-deploy verification for the live Pages site
- `worker/src/index.js` Worker API for sessions and leads

## Prompt Pack

The repo now includes a prompt-only ChatGPT project pack at `docs/prompt-pack/`.

- Use `docs/prompt-pack/MASTER_PROJECT_PROMPT.md` as the single-file project prompt.
- Upload `docs/prompt-pack/irish_tax_ai_cheat_sheet_v1.1.md` alongside it if you want Irish tax scenarios to use the workbook logic directly.
- Use the component files in the same folder when you want to tune individual playbooks without changing the app.
- Use `docs/prompt-pack/90_examples_and_regression_prompts.md` for shadow testing before replacing the live project prompt.
