# Langfuse setup

**No Langfuse account exists for this project.** Nothing has ever been provisioned — not a
local `.env`, not a Cloudflare Worker secret, not a GitHub Actions secret, not a Render
environment variable. There is nothing to look up and nothing to copy from another
environment. This is a from-scratch setup.

That needs saying plainly, because the repository has carried Langfuse *scaffolding* since
`782c206` and it reads like configuration: a `FetchLangfuseSink`, a `LangfuseForwardWorker`, a
masking allowlist in `config/observability.yaml`, three placeholders in `.env.example`. All of
it was written to activate later. The comments say so — *"reserved for a later traced-AI
flow"*, *"activates only when Cloud EU credentials are present"*, *"absent credentials keep the
dormant no-op sink"* — but only if you read them as conditions rather than statements.

Everything stays dormant and makes zero network calls until the keys below exist.

## What was checked, and where nothing was found

| Surface | Evidence |
|---|---|
| Local `.env` | Gitignored (`.gitignore:10`), absent from disk, never committed |
| `.env.example` | Three empty placeholders |
| `Makefile:18-20` | `LANGFUSE_* ?=` — empty defaults |
| GitHub Actions | No Langfuse reference in any workflow. Secrets used: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `OPENAI_API_KEY`, `ADVISOR_SMOKE_PASSWORD` |
| Cloudflare secrets | `deploy-worker.yml` pushes only `OPENAI_API_KEY` and `CONSUMER_DEPLOY_VERIFICATION_KEY` |
| Render | `render.yaml` declares only `DATABASE_URL`, `SERVICE_HOST`, `NODE_ENV`, `LOG_LEVEL` |
| Git history | No credential value in any commit. The only `pk-lf-`/`sk-lf-` match is the placeholder `'pk-lf-test'` in `scripts/check-consumer-tracing.mjs` |

## 1. Create the account

Sign up at **<https://cloud.langfuse.com>**.

**The region is chosen by which URL you sign up at, and it cannot be changed afterwards.**
`cloud.langfuse.com` is the EU region (AWS `eu-west-1`, Ireland); `us.cloud.langfuse.com` is a
separate account namespace in Oregon, not a setting inside the same account. Use the EU one —
this is an Irish financial-planning product, and while the production path exports no
conversation content, harness runs do export synthetic transcripts.

The free **Hobby** tier is enough: 50,000 units/month, 30-day retention, 2 seats, no card
required. Confirm current terms at <https://langfuse.com/pricing> — free-tier limits change.

30-day retention is worth noting: Langfuse is a **disposable lens**, not a record. Anything
that needs to outlive a month belongs in the local `agent-runs/` archive or the
learning-signals ledger. `services/learning-signals/README.md:444` already says this.

## 2. Create a project and get the keys

1. Create an organisation, then a project inside it (e.g. `planeir`).
2. **Project → Settings → API Keys → Create new API keys.**
3. You get a pair:
   - `pk-lf-…` — public key → `LANGFUSE_PUBLIC_KEY`
   - `sk-lf-…` — secret key → `LANGFUSE_SECRET_KEY`

Copy the secret when it is shown. If you later find it is not displayed again, **do not go
looking for a way to recover it** — create a new key pair and delete the old one. Both halves
are project-scoped, so rotating them affects nothing else.

Consider a second project (`planeir-harness`) if you want synthetic harness runs kept away
from live worker traces. One project is fine to start; the traces are already tagged by lane.

## 3. Put the variables where they are needed

**Only the first row is needed to run `npm run verify:langfuse` or any harness run.** The rest
are for when you want live worker traces.

### Local — the only one needed now

Put them in **`.env.local`** in the repository root (gitignored, `.gitignore:11`):

```
LANGFUSE_PUBLIC_KEY=pk-lf-…
LANGFUSE_SECRET_KEY=sk-lf-…
LANGFUSE_HOST=https://cloud.langfuse.com
```

`LANGFUSE_HOST` may be omitted — the harness defaults to the EU region.

`npm run verify:langfuse` loads them with Node's own `--env-file-if-exists`, no dependency:

```
--env-file-if-exists=.env --env-file-if-exists=.env.local
```

Both are optional and a missing one is not an error — Node prints a one-line
`… not found. Continuing without it.` and carries on. **`.env.local` is listed last on
purpose**: Node applies `--env-file` in order and the last occurrence of a key wins, so
`.env.local` takes precedence over `.env`. A variable exported in your shell beats both, so a
one-off run can override the file without editing it.

The `Makefile` is separate and older: it reads `.env` only, via `-include .env`
(`Makefile:5,34`), for the learning-signals `make` targets. It does not read `.env.local`.

The other harness runners (`probe:live-personas`, `run-consumer-agent-call.mjs`, …) do **not**
load `.env` — they take the variables from the environment, so either export them in your
shell or pass them inline:

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-… LANGFUSE_SECRET_KEY=sk-lf-… npm run verify:langfuse
```

### This must be run on your own machine

Claude Code sessions here run in a **disposable cloud container** that is rebuilt from a fresh
git clone each time. It cannot see files on your laptop, and a `.env` created inside one
session is gone when that container is reclaimed. `.env` is also gitignored, so it is never
carried across in a commit.

So the verifier has to be run locally by you, or the three variables have to be configured on
the remote environment itself (Claude Code → environment settings → environment variables),
which puts the secret key inside that sandbox. Running locally keeps the secret on your
machine and is the better default.

### Cloudflare Worker — for live call traces

The two keys are secrets and must not go in `wrangler.toml`:

```bash
cd worker
npx wrangler secret put LANGFUSE_PUBLIC_KEY
npx wrangler secret put LANGFUSE_SECRET_KEY
```

`LANGFUSE_HOST` and the flags are plain vars in `worker/wrangler.toml` (currently
`LANGFUSE_HOST = ""`, `CONSUMER_TRACING_ENABLED = "false"`). All four must be set before a
single span is built — see `isTracingConfigured` in `worker/src/consumer/tracing.js`.

Secrets set with `wrangler secret put` are **write-only**: Cloudflare will list the names but
never return the values. If you lose the secret key, rotate it in Langfuse and push the new one.

### GitHub Actions — only if tracing is deployed via CI

`deploy-worker.yml` pushes secrets to Cloudflare during deploy. It does **not** reference
Langfuse today. If you want it to, add `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` under
**Settings → Secrets and variables → Actions → New repository secret**, then extend the
`secret put` block. GitHub secrets are also write-only once saved.

### Render — the dormant M7 outbox, out of scope

The `planeir-learning-signals` service reads the same three names
(`services/learning-signals/src/config.ts:30-32`). Setting them there activates
`LangfuseForwardWorker`, which forwards **masked, metadata-only** provider usage. Nothing
currently writes to `provider_usage`, so this does nothing yet. Add them under the service's
**Environment** tab in the Render dashboard if that pipeline is ever finished.

## 4. What each surface exports

| Path | Conversation text? |
|---|---|
| Agent harness (`scripts/`) | **Yes** — full prompts and completions. Safe: it only ever replays synthetic personas and the scenario library, never a real session |
| Worker, cohort in `CONSUMER_AGENT_TEST_COHORTS` | **Yes** — calls we place ourselves must be debuggable |
| Worker, any other cohort **including production** | **No.** Model, tokens, latency, cost, status and tree shape only |
| learning-signals outbox | **No** — masked to the allowlist in `config/observability.yaml` |

Production runs the `internal` cohort (`worker/wrangler.toml:86`), which is **not** in the
agent-test list. `scripts/check-consumer-tracing.mjs` asserts the absence of content as a
negative test and fails if the mask stops masking.

## 5. Verify

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-… LANGFUSE_SECRET_KEY=sk-lf-… npm run verify:langfuse
```

Free — no OpenAI key, no model calls, no spend. It posts through the real code paths, reads
back what Langfuse stored, and prints a `sent → landed` table. The first paid step is the
persona probe afterwards, and that spends on **OpenAI**, not Langfuse.
