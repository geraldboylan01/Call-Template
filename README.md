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

## Lead Capture

The landing page form posts to the existing Cloudflare Worker:

- Endpoint: `POST /api/leads`
- Storage: the existing `SESSIONS_BUCKET` R2 bucket under the `leads/` prefix
- Stored fields: `createdAt`, `fullName`, `email`, `phone`, `reason`, `stage`, `source`

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

## File Structure

- `index.html` public landing page
- `app/index.html` advisor app
- `app/session.html` client viewer
- `session.html` compatibility redirect for older links
- `styles/landing.css` landing page styling
- `styles/base.css` advisor app styling
- `js/landing.js` landing page interactions and lead form submission
- `js/app.js` advisor app logic
- `js/session_viewer.js` client viewer logic
- `worker/src/index.js` Worker API for sessions and leads
