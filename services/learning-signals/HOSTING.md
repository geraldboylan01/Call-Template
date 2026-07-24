# Hosting the learning-signal service (integration Phase 3)

This service is Node + Fastify + **PostgreSQL 16**. Your website is Cloudflare
(edge Worker + static), which cannot run this service, so it lives on a separate
Node host with a managed Postgres. The worker (which stays on Cloudflare) then
POSTs finished-call summaries to the hosted service over HTTPS.

**What you do vs. what is prepared.** The repo now contains everything needed to
deploy — a `Dockerfile`, a Render blueprint (`render.yaml`), a `/health` probe,
migrations that run on boot, `$PORT` binding, and Postgres-over-SSL. Creating the
hosting account, accepting its terms, and clicking deploy are yours to do (they
involve account creation and possibly a card); this guide is the exact steps.

Everything here is a **pilot** setup for testing a couple of calls. It is not a
production hardening guide.

---

## Option A — Render blueprint (simplest, one click)

Provisions a free web service **and** a free Postgres 16 from `render.yaml`.

1. **Push the repo to GitHub** (it already is) and make sure `render.yaml` is on
   the branch you will deploy.
2. In Render: **New → Blueprint**, connect the repo, and apply. Render reads
   `render.yaml` and creates `planeir-learning-signals-db` (Postgres 16) and the
   `planeir-learning-signals` web service (built from the Dockerfile). The
   service applies migrations on boot and comes up green when `/health` returns
   200.
3. **Note the service URL**, e.g. `https://planeir-learning-signals.onrender.com`.
4. **Provision a tenant against the hosted database.** From the Render database
   page copy the **external** connection string (it includes `sslmode=require`),
   then from your laptop:
   ```bash
   DATABASE_URL="<external-db-url>" \
     make provision SLUG=planeir NAME="Planeir Pilot" MODULE="Test Planner"
   ```
   This prints, once: the three API key secrets, the `module_id` /
   `module_version_id`, and a `TENANT_SECRETS_JSON` entry. Store them securely.
5. **Give the service its pseudonymisation secret.** In the Render web service
   **Environment** tab, set `TENANT_SECRETS_JSON` to the printed value and save
   (this triggers a redeploy). Until it is set, `POST /v1/sessions` returns 503.
6. **Warm the service** (free instances spin down when idle):
   ```bash
   curl https://<service-url>/health      # -> {"status":"ok"}
   ```
7. **Point the worker at it.** In `worker/wrangler.toml` set
   `LEARNING_SIGNALS_URL` and `LEARNING_SIGNALS_MODULE_ID`, and set the ingest
   key as a secret:
   ```bash
   cd worker
   wrangler secret put LEARNING_SIGNALS_INGEST_KEY   # paste the ingest key
   ```
   Then `wrangler deploy` (or `wrangler dev` for a local worker pointed at the
   hosted service). With all three set, finished calls emit; leave any blank and
   the emitter is a complete no-op.
8. **Do a couple of test calls**, hang up, then look at what landed:
   ```bash
   DATABASE_URL="<external-db-url>" make metrics           # compute daily metrics
   # or inspect the ledger directly:
   psql "<external-db-url>" -c \
     "select event_type, attrs->>'outcome' outcome from session_events order by received_at desc limit 20;"
   ```

---

## Option B — Neon (persistent free Postgres) + any Node host

Render's free Postgres is time-limited; for a database that persists, use
[Neon](https://neon.tech) (free serverless Postgres 16, no card) and deploy the
Dockerfile anywhere (Fly.io, Koyeb, Render web-only):

1. Create a Neon project → copy its connection string (has `sslmode=require`).
2. Apply migrations once: `DATABASE_URL="<neon-url>" make db-migrate`.
3. Deploy `services/learning-signals/Dockerfile` on your chosen host, setting
   `DATABASE_URL=<neon-url>`, `SERVICE_HOST=0.0.0.0`, `NODE_ENV=production`, and
   (after step 4 of Option A) `TENANT_SECRETS_JSON`.
4. Provision, warm, wire the worker, and inspect exactly as in Option A.

---

## What a hosted call captures

Once wired, each finished call emits a minimised **session summary** from the
single `terminalize` hook: `session.started`, `call.connected`,
`call.dropped` / `call.connect_failed`, and `session.completed`
(outcome + turn count + technical/non-technical cause). That yields
**completion, abandonment, and reliability** metrics. Per-turn question timing,
extraction/calibration, and cost are deferred emitter follow-ups (not yet wired).

## Free-tier caveats (read before testing)

- **Spin-down / cold start.** A free web service sleeps after ~15 min idle; the
  first request then waits tens of seconds. The emitter times out after 5s and
  swallows failures, so a cold-start miss loses *that call's* telemetry, not the
  call. **Warm with `GET /health` before each test call.**
- **Background jobs.** The retention/metrics schedulers only run while the
  instance is awake. Compute metrics on demand with `make metrics` against the
  hosted `DATABASE_URL` instead of relying on the scheduler.
- **Third-party sinks stay off.** With no PostHog/Langfuse/OTel credentials the
  service makes zero external calls (No-op sinks) — it only receives and stores.
- **Secrets.** Treat the ingest key and `TENANT_SECRETS_JSON` like passwords;
  they are shown once. Rotate by re-provisioning if leaked.
- **Confirm current terms.** Free-tier limits change; verify with the provider.

## Verifying the image locally

The Dockerfile is self-contained (context = this directory):

```bash
docker build -t planeir-learning-signals services/learning-signals
```
