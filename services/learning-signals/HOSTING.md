# Hosting the learning-signal service

This service is Node + Fastify + **PostgreSQL 16**. Your website is Cloudflare
(edge Worker + static), which cannot run this service, so it lives on a separate
Node host. The long-term hosted topology is the Render web service plus a Neon
PostgreSQL database. The worker (which stays on Cloudflare) POSTs finished-call
summaries to the service over HTTPS.

The repo contains the Dockerfile, a web-service-only Render blueprint, a
`/health` probe, migrations that run on boot, `$PORT` binding, and managed
Postgres TLS support. `DATABASE_URL` remains a secret supplied by the hosting
environment; no database connection string belongs in git.

Everything here is a **pilot** setup for testing a couple of calls. It is not a
production hardening guide.

---

## Current topology — Neon + Render web service

`render.yaml` manages only `planeir-learning-signals`. It intentionally does not
define a Render Postgres resource. `DATABASE_URL` is declared with `sync: false`,
so an initial Blueprint asks for it and later Blueprint syncs do not overwrite
the dashboard-managed value.

For a brand-new deployment:

1. Create a PostgreSQL 16 Neon project and copy its **direct/unpooled** connection
   string. Keep the provider's TLS query parameters intact.
2. Apply the repository migrations:
   ```bash
   DATABASE_URL="<neon-direct-url>" make db-migrate
   ```
3. In Render, choose **New → Blueprint**, connect this repository, and apply
   `render.yaml`. Supply the Neon URL when Render asks for `DATABASE_URL`.
4. For a genuinely new database only, provision the first tenant:
   ```bash
   DATABASE_URL="<neon-direct-url>" \
     make provision SLUG=planeir NAME="Planeir Pilot" MODULE="Test Planner"
   ```
   This prints, once: four scoped API key secrets, the `module_id` /
   `module_version_id`, and a `TENANT_SECRETS_JSON` entry. Store them securely.
5. In the Render service's **Environment** page, add `TENANT_SECRETS_JSON` and
   choose **Save and deploy**. Until it is set, `POST /v1/sessions` returns 503.
6. Note the service URL and warm the service:
   ```bash
   curl https://<service-url>/health      # -> {"status":"ok"}
   ```
7. Point the worker at it. The emitter requires `LEARNING_SIGNALS_URL`,
   `LEARNING_SIGNALS_MODULE_ID`, `LEARNING_SIGNALS_RETENTION_DAYS`, and the
   ingest-key secret. The read-key secret separately powers advisor analytics.
   ```bash
   cd worker
   wrangler secret put LEARNING_SIGNALS_INGEST_KEY   # paste the ingest key
   wrangler secret put LEARNING_SIGNALS_READ_KEY     # paste the read key
   wrangler deploy
   ```
8. Do a couple of test calls, then inspect the Neon ledger:
   ```bash
   DATABASE_URL="<neon-direct-url>" make metrics
   psql "<neon-direct-url>" -c \
     "select event_type, attrs->>'outcome' outcome from session_events order by received_at desc limit 20;"
   ```

---

## Migrating an existing Render Postgres database

Use PostgreSQL **16.x** client tools against a dedicated, empty Neon target.
`pg_dump` provides one consistent source snapshot. The restore is transactional
and excludes source ownership and privileges, which are not portable to Neon.

The restore command below replaces objects on the target. Confirm the two URLs
resolve to different databases and that the target contains no data you need.
Keep the temporary archive only until verification finishes.

```bash
set -euo pipefail

# Load both values from a password manager or hidden prompt. Never put them in
# this repository, a command transcript, or a committed .env file.
export SOURCE_DATABASE_URL
export TARGET_DATABASE_URL
: "${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL must be set}"
: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL must be set}"

pg_dump --version       # must report 16.x
pg_restore --version    # must report 16.x

# Preflight the app migrations and compatibility against the target.
DATABASE_URL="$TARGET_DATABASE_URL" make db-migrate

dump_file="$(mktemp "${TMPDIR:-/tmp}/planeir-learning-signals.XXXXXX")"
chmod 600 "$dump_file"
trap 'rm -f "$dump_file"' EXIT

pg_dump --dbname="$SOURCE_DATABASE_URL" \
  --format=custom --compress=9 \
  --no-owner --no-privileges \
  --serializable-deferrable --lock-wait-timeout=10s \
  --file="$dump_file"

pg_restore --dbname="$TARGET_DATABASE_URL" \
  --clean --if-exists \
  --no-owner --no-privileges \
  --exit-on-error --single-transaction \
  "$dump_file"

# Confirms the copied Drizzle ledger is current and the runner stays idempotent.
DATABASE_URL="$TARGET_DATABASE_URL" make db-migrate
```

Compare exact counts for every application table on both databases:

```bash
for database_url in "$SOURCE_DATABASE_URL" "$TARGET_DATABASE_URL"; do
  psql "$database_url" -X -v ON_ERROR_STOP=1 <<'SQL'
SELECT format(
  'SELECT %L AS table_name, count(*)::bigint AS row_count FROM %I.%I;',
  tablename, schemaname, tablename
)
FROM pg_catalog.pg_tables
WHERE schemaname = 'public'
ORDER BY tablename
\gexec
SQL
done
```

Also compare the migration count, latest key-row timestamps, invalid indexes,
unvalidated constraints, and database collation. A logical dump restores schema
objects and data, but it does not change the target database's default collation.

The database copy includes tenant rows, API-key hashes, module IDs, migrations,
views, functions, indexes, constraints, and triggers. It does **not** contain the
plaintext API keys or `TENANT_SECRETS_JSON`; keep the existing values in the
Render and Cloudflare secret stores. Do not provision a replacement tenant after
a migration.

### Manual Render cutover

1. Merge the updated `render.yaml`, then open the service's Render Blueprint and
   run **Manual Sync**. Confirm `DATABASE_URL` is no longer a `fromDatabase`
   reference. The existing Render database remains intact.
2. Stop test/production calls, select `planeir-learning-signals` in the Render
   service list, choose **Suspend**, and wait until it is suspended. This stops
   both incoming writes and the service's in-process background jobs.
3. While the service is suspended, repeat the final dump/restore and verification
   so the cutover snapshot cannot drift.
4. Open the service's **Environment** page, edit `DATABASE_URL`, paste the Neon
   direct/unpooled URL, and choose **Save and deploy**. Do not change
   `TENANT_SECRETS_JSON`. If Render leaves the service suspended, choose
   **Resume** after saving.
5. Watch the deploy log for the migration-success message and a clean service
   start. Then verify `GET /health` and make an authenticated, read-only analytics
   request before resuming calls.
6. Resume the worker and confirm a new event lands only in Neon.

Keep the old Render database intact and unused for **14 days** as a rollback
snapshot. A simple rollback is safe only before Neon accepts new writes; after
that, switching back would lose Neon-only events unless they are copied in
reverse. After the observation window, take any required final archive and
delete the Render database manually. Removing it from `render.yaml` does not
delete the existing Render resource. A free Render Postgres database expires 30
days after creation and is inaccessible during its 14-day upgrade grace period,
so first confirm that at least 14 active days remain. Otherwise, upgrade it for
the observation window or retain an encrypted dump in approved backup storage.

---

## Neon + another Node host

The Dockerfile can run on Fly.io, Koyeb, or another Node/Docker host:

1. Apply migrations to Neon as above.
2. Deploy `services/learning-signals/Dockerfile`, setting `DATABASE_URL`,
   `SERVICE_HOST=0.0.0.0`, `NODE_ENV=production`, and `TENANT_SECRETS_JSON` in the
   host's secret store.
3. Provision only for a new database, then warm, wire, and verify as above.

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
