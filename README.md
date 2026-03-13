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
