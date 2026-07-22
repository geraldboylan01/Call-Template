# Planeir learning signals

This directory is the M0 scaffold for Planeir's privacy-first, service-to-service
learning-signal layer. It is deliberately isolated from the existing Cloudflare
Worker and its D1 databases: telemetry uses PostgreSQL 16 only.

## Stack decision

Before this scaffold was written, the following established Planeir files were
inspected: `package.json`, `package-lock.json`, the root `README.md`, `.gitignore`,
`.github/workflows/consumer-regression.yml`, `worker/wrangler.toml`,
`worker/wrangler.consumer-test.toml`, `worker/src/index.js`,
`worker/src/consumer/router.js`, `worker/src/consumer/config.js`,
`worker/src/consumer/validators.js`, `worker/src/consumer/repository.js`,
`worker/consumer-migrations/0001_create_consumer_journey.sql`,
`scripts/check-consumer-worker.mjs`, and `scripts/check-consumer-http.mjs`.

Planeir currently uses Node 22 ES modules, a framework-free Cloudflare Worker,
handwritten validation, raw D1 SQL migrations, and `node:assert` scripts. Because
the repository has no existing framework, ORM, schema library, or test runner,
this isolated service uses the brief's complete approved Node stack: Node 22,
TypeScript, Fastify, Drizzle ORM with drizzle-kit migrations, Zod, and Vitest.

## Local gate

From the repository root:

```sh
docker compose up -d
make db-migrate
make test
make lint
```

`make test` connects to PostgreSQL and fails unless it is PostgreSQL 16 and the
Drizzle migration ledger exists. It has no SQLite or in-memory fallback. Copy
`.env.example` to `.env` only when local overrides are needed; never commit real
credentials.

