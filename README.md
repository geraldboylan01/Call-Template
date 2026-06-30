# Planeir

Planeir now ships as two connected experiences:

- `/` is the public landing page for first-time visitors.
- `/app/` is the existing advisor workspace. The public landing page includes an "Admin Login" link to `/app/?login=1&return=home`; after sign-in, the advisor returns to `/` and sees the separate "Open app" link. Unauthenticated `/app/` visits redirect back to the request form.
- `/app/clients.html` is the advisor-only client pipeline for reviewing leads, choosing call times, managing published sessions, and sending post-session emails from one client record.
- `/app/video.html` is the local-only capture composer opened from an advisor module. It does not fetch or transmit client data.
- `/app/session.html?id=...` is the client session viewer used by published links.
- `/session.html?id=...` remains as a compatibility redirect to `/app/session.html?id=...`.

## Local Development

Static site:

1. Serve the repo with any static server.
2. Open `/` for the landing page.
3. Open `/app/?login=1&return=home` to sign in as an advisor and return to the homepage, or `/app/` when an advisor session already exists.

Worker:

1. From `worker/`, run the Cloudflare Worker locally with Wrangler.
2. The static site will use `http://127.0.0.1:8787` automatically on `localhost` / `127.0.0.1`.
3. Apply the D1 migrations before testing lead capture:

```bash
cd worker
npx wrangler d1 migrations apply planeir-leads --local
```

### Video Scene Capture

Open a module in the advisor workspace and choose **Create video scene**. The app resolves the active calculator scenario into a versioned local scene manifest, opens a 1920×1080 browser composition, and reserves the right third for the presenter. The composer lists the client identity, session/module identifiers, and every visible metric; **Start capture sequence** remains disabled until the review is marked complete.

The scene manifest is held in same-origin session storage in the local browser session. It is not added to a URL, published with a client session, or sent to a service. Use **Presenter left** to mirror the layout and `Escape` to leave capture mode.

### Subscription-Only Codex Video Director

Use **Copy Call for Codex** in the advisor workspace to prepare a complete local `CodexVideoBrief v1` for the current call. The review dialog identifies the client, lists every included module in session order, warns that approved real client data is present, and offers clipboard copy plus JSON download.

The app does not call an AI API, send a Worker-to-model request, require an OpenAI API key, or create a per-token API charge. Copying is a manual hand-off: paste the packet into an authenticated Codex conversation included with your ChatGPT/Codex plan, then Codex creates the bespoke recording page locally.

For a linked pipeline client, the advisor-only `GET /api/advisor/clients/:id/codex-video-context` endpoint returns only the allowlisted narrative context: identity, stated reason, advisor notes, consent state, and safe timeline events. The packet always excludes email/phone, schedule response and invite values, Zoom details, credentials, PINs, capability/auth/recovery/R2 values, and secure links. Calculator modules are re-resolved from the active scenario; PBS includes the currently selected case and all available PBS cases. Module image entries are metadata only, so attach the named images separately in Codex when needed.

The copied instruction directs bespoke work to a local, git-ignored directory:

```text
private/video-calls/<date>-<client-slug>/
```

Codex should create `index.html`, its scoped CSS/JS, `storyboard.md`, `source-brief.json`, and `quality-review.md` there. Each bespoke page should include a local-only presenter recorder mode: start camera/mic, enter fullscreen, record the current tab/window with browser-native `getDisplayMedia` + `MediaRecorder`, stop with `S`, `Esc`, browser stop-sharing, or a hidden emergency stop control, and save a local WebM. The quality review is part of the output contract: every bespoke scene should be checked for duplicate branding, text/chart/card/metric overlaps, presenter-zone intrusions, presenter camera fit, setup controls hidden during capture, fullscreen stop controls that do not force visible UI into the recording, small-screen legibility, static dead time, step-through/progress accuracy, scene-to-scene visual continuity, reuse of moving visual elements rather than slide-by-slide rebuilds, ambiguous decorative marks that could be misread as charts/arrows/decision paths, underlying-problem diagnosis before solution mechanics, decision-first sequencing, and whether the opening seconds match the promised topic. When a module includes source studies or return tables, the bespoke page should preserve the study source, risk-free or fixed-rate comparison, average-return potential, and downside risk instead of over-compressing the point into one chart. When a scene shows a derived figure, show the formula and planning rationale where the brief provides it. That directory is neither built nor deployed. Open the resulting `index.html` locally, use the built-in recorder, or capture it in OBS/Screen Studio as a fallback.

## Lead Capture

The landing page form posts to the existing Cloudflare Worker:

- Endpoint: `POST /api/leads`
- Storage: the `LEADS_DB` D1 binding, table `leads`
- Stored columns include contact details, submitted context, availability notes, consent fields, workflow status, advisor notes, schedule metadata, client schedule responses, and schedule email counts
- Migration files: `worker/migrations/0001_create_leads.sql`, `worker/migrations/0002_add_call_outcome_to_leads.sql`, `worker/migrations/0008_add_education_only_consent_to_leads.sql`, `worker/migrations/0009_add_lead_scheduling_workflow.sql`, `worker/migrations/0010_add_zoom_meeting_fields_to_leads.sql`, `worker/migrations/0011_add_lead_schedule_response_fields.sql`, `worker/migrations/0012_add_zoom_cleanup_fields.sql`
- Email notifications: Resend API is called from the Worker after a successful D1 insert

### Client Pipeline And Scheduling

The advisor client pipeline lives at `/app/clients.html` and uses the existing advisor auth cookie and CSRF flow. Legacy `/app/leads.html` and `/app/access.html` requests redirect there.

Advisor endpoints:

- `GET /api/advisor/clients`
- `GET /api/advisor/clients/:id`
- `PATCH /api/advisor/clients/:id`
- `GET /api/advisor/leads`
- `GET /api/advisor/leads/:id`
- `PATCH /api/advisor/leads/:id`
- `POST /api/advisor/leads/:id/send-schedule-email`
- `GET /api/leads/schedule-response` for client accept/decline links

The schedule email endpoint creates a 30-minute Zoom meeting, sends a branded client email through Resend with a `planeir-call.ics` calendar invite attachment, and uses the Zoom join URL as the invite location. The email includes secure accept and decline links that expire after 48 hours. Accepted calls move to `booked`; declined calls move to `declined` and attempt to delete the Zoom meeting; expired unaccepted proposals are marked `expired` and deleted from Zoom by the hourly Worker cron cleanup. It also sends a separate advisor copy to `LEAD_ADVISOR_COPY_TO` when configured. This is a short-term calendar-invite workflow only; it does not create or manage a Google Calendar or Outlook event.

### Lead Email Configuration

The Worker sends a non-blocking internal notification email after a lead is stored successfully. An optional submitter confirmation email can also be enabled.

Recommended configuration:

- Secret: `RESEND_API_KEY`
- Variable or secret: `LEAD_EMAIL_FROM`
- Variable or secret: `LEAD_NOTIFICATION_TO`
- Optional variable or secret: `LEAD_REPLY_TO`
- Optional variable or secret: `LEAD_ADVISOR_COPY_TO`
- Optional variable or secret: `LEAD_CONFIRMATION_EMAIL_ENABLED`
- Secret or variable: `ZOOM_ACCOUNT_ID`
- Secret or variable: `ZOOM_CLIENT_ID`
- Secret: `ZOOM_CLIENT_SECRET`
- Secret or variable: `ZOOM_USER_ID`

Example setup:

```bash
cd worker
wrangler secret put RESEND_API_KEY
wrangler secret put LEAD_EMAIL_FROM
wrangler secret put LEAD_NOTIFICATION_TO
wrangler secret put LEAD_REPLY_TO
wrangler secret put LEAD_ADVISOR_COPY_TO
wrangler secret put ZOOM_ACCOUNT_ID
wrangler secret put ZOOM_CLIENT_ID
wrangler secret put ZOOM_CLIENT_SECRET
wrangler secret put ZOOM_USER_ID
```

For the optional confirmation email toggle, set `LEAD_CONFIRMATION_EMAIL_ENABLED=true` in the Cloudflare dashboard or in local Wrangler development variables.

For local Zoom testing, create an uncommitted `worker/.dev.vars` file:

```ini
ZOOM_ACCOUNT_ID="your Zoom account ID"
ZOOM_CLIENT_ID="your Zoom client ID"
ZOOM_CLIENT_SECRET="your Zoom client secret"
ZOOM_USER_ID="your Zoom login email"
```

Notes:

- `LEAD_EMAIL_FROM` must be a sender address verified with Resend, for example `Planeir <hello@yourdomain.com>`.
- `LEAD_NOTIFICATION_TO` can be Gerry's email address or a comma-separated list of internal recipients.
- The internal notification uses the submitter's email as `Reply-To`, so Gerry can reply directly.
- `LEAD_REPLY_TO` should be `hello@planeir.ie` for branded client-facing confirmations and schedule emails.
- `LEAD_ADVISOR_COPY_TO` receives separate advisor copies of schedule emails. If it is not set, the Worker falls back to `LEAD_NOTIFICATION_TO`.
- In Zoom Marketplace, choose Server-to-Server OAuth App for this integration. `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, and `ZOOM_CLIENT_SECRET` come from that app's credentials page. Add meeting write/create and meeting delete scopes for the Zoom user that will host the calls.
- `ZOOM_USER_ID` should usually be the Zoom account email that will host Planeir calls.
- In Cloudflare, paste these under Workers & Pages -> the Worker -> Settings -> Variables and Secrets. Use Secret for `ZOOM_CLIENT_SECRET`; the other Zoom values can also be secrets if you want to keep the dashboard tidy.
- If email delivery fails or email is not configured, the lead is still stored and the API still returns success.

Inbound mail to `hello@planeir.ie` is handled separately from this outbound Resend path. See [docs/email-architecture.md](/Users/geraldboylan/Documents/GitHub/Call-Template/docs/email-architecture.md) for the intended Cloudflare Email Routing setup.

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
- Optional variable or secret: `TRUSTPILOT_AFS_EMAIL`

Notes:

- `SESSION_ADVISOR_NOTIFICATION_TO` should point to Gerry's inbox. The default implementation target is `geraldboylan@gmail.com`.
- If `SESSION_EMAIL_FROM` is not set, the Worker falls back to `LEAD_EMAIL_FROM`.
- The advisor notification is non-blocking. If email delivery fails or email is not configured, publish still succeeds and the Worker only logs the failure.
- The advisor notification includes the client name, advisor reopen link, client link when provided, published timestamp, expiry, published session id, and the current client PIN flow summary.
- When a client email is entered, `Publish Secure Links` now publishes and immediately sends the client-facing final email.
- If `TRUSTPILOT_AFS_EMAIL` is set, the client-facing final email includes that unique Trustpilot Automatic Feedback Service address as BCC so Trustpilot can queue its own review invitation.
- Ongoing resend, recovery, reset, revoke, and expiry-management flows now live on `/app/clients.html`.
- Sessions published after the recovery-storage update can be searched and recovered from the Client Pipeline without needing the original advisor reopen link.

Example setup:

```bash
cd worker
wrangler secret put RESEND_API_KEY
wrangler secret put SESSION_EMAIL_FROM
wrangler secret put SESSION_EMAIL_REPLY_TO
```

Set `SESSION_ADVISOR_NOTIFICATION_TO=geraldboylan@gmail.com` in Wrangler vars, the Cloudflare dashboard, or local Wrangler development variables.

For Trustpilot AFS, set `TRUSTPILOT_AFS_EMAIL=planeir.ie+c36359b3d5@invite.trustpilot.com` in Wrangler vars, the Cloudflare dashboard, or local Wrangler development variables.

## Organic SEO

The public homepage is positioned as Irish financial education, not regulated financial advice. The static build publishes:

- `robots.txt` with a sitemap reference
- `sitemap.xml` containing only `https://planeir.ie/`
- canonical, Open Graph, Twitter, and JSON-LD metadata on `/`
- `noindex, nofollow` metadata on `/app/`, `/app/session.html`, `/app/clients.html`, `/app/access.html`, and `/session.html`
- `assets/brand/planeir-social-card.png` for social previews

The public contact address is `hello@planeir.ie`. Configure inbound delivery through Cloudflare Email Routing and forward it to Gerry's real inbox. This is separate from the existing outbound Worker/Resend email setup; see [docs/email-architecture.md](/Users/geraldboylan/Documents/GitHub/Call-Template/docs/email-architecture.md).

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
7. Open `/app/clients.html`, sign in, choose the client, set a date/time, and send the schedule email.
8. Confirm the client-facing email comes from `hello@planeir.ie` and includes `planeir-call.ics`.
9. Confirm the advisor copy goes only to `LEAD_ADVISOR_COPY_TO` or the fallback notification recipient.
10. To test failure handling, temporarily remove `RESEND_API_KEY` or use an invalid key, submit again, and confirm the API still returns success while the Worker logs the notification failure. Then try schedule sending and confirm the lead inbox reports the send failure.

## Testing Published Session Emails

1. Configure `RESEND_API_KEY`, `SESSION_EMAIL_FROM`, and `SESSION_ADVISOR_NOTIFICATION_TO` for the Worker.
2. Run the static site and the Worker locally, or deploy the Worker with those variables set.
3. Open `/app/`, publish a client session, and confirm the publish succeeds without exposing the old link-management panel in the publish modal.
4. Confirm the advisor notification email arrives at `geraldboylan@gmail.com` with the advisor reopen link, client name, publish time, expiry, and published session id.
5. Open `/app/clients.html`, search for the published client, and confirm the recovered client link and advisor reopen link are available there.
6. From `/app/clients.html`, resend the final email, extend expiry, and reset client access, confirming each action updates the selected record.
7. To test failure handling, temporarily remove `RESEND_API_KEY` or set an invalid key, publish again, and confirm the publish still succeeds while the Worker logs the advisor notification failure instead of breaking the UI.

## File Structure

- `index.html` public landing page
- `app/index.html` advisor app
- `app/clients.html` advisor-only client pipeline
- `app/video.html` local 16:9 video capture composer
- `app/access.html` compatibility redirect to the client pipeline
- `app/session.html` client viewer
- `session.html` compatibility redirect for older links
- `dist/` the only GitHub Pages deploy artifact
- `docs/prompt-pack/` zero-token ChatGPT project prompt pack, including the assembled `MASTER_PROJECT_PROMPT.md`
- `docs/artifact-module-upgrade.md` notes for the upgraded structured artifact module capabilities
- `styles/landing.css` landing page styling
- `styles/base.css` advisor app styling
- `styles/video_scene.css` video composer styling and capture-safe layout
- `js/landing.js` landing page interactions and lead form submission
- `js/app.js` advisor app logic
- `js/video_scene.js` resolved module-to-video manifest adapter
- `js/codex_video_brief.js` full-call, copy-and-paste Codex video brief adapter
- `js/video_composer.js` local video scene renderer and review gate
- `js/session_viewer.js` client viewer logic
- `scripts/check-pages-versioned-assets.sh` post-deploy verification for the live Pages site
- `scripts/check-video-scene.mjs` manifest regression checks across module types
- `scripts/check-codex-video-brief.mjs` brief order, scenario, privacy, and output-path checks
- `worker/src/index.js` Worker API for sessions and leads

## Prompt Pack

The repo now includes a prompt-only ChatGPT project pack at `docs/prompt-pack/`.

- Use `docs/prompt-pack/MASTER_PROJECT_PROMPT.md` as the single-file project prompt.
- Upload `docs/prompt-pack/irish_tax_ai_cheat_sheet_v1.1.md` alongside it if you want Irish tax scenarios to use the workbook logic directly.
- Use the component files in the same folder when you want to tune individual playbooks without changing the app.
- Use `docs/prompt-pack/90_examples_and_regression_prompts.md` for shadow testing before replacing the live project prompt.
- Use `docs/prompt-pack/91_artifact_payload_examples.md` for representative Dev Panel payloads that exercise the artifact-style renderer.
