# Planéir — Implementation Design & Build Prompts

*How to turn the current repo into the two-engine business, and the exact, sequenced prompts to hand your coding agent so you can stay on content, consumer growth and B2B selling. Prepared for Gerry, July 2026. Grounded in a read of the actual codebase.*

---

## Part A — Assessment: what you already have

The good news is you are much closer than the strategy docs implied. A deep read of the repo shows **Engine 2 (the consumer funnel) is roughly 80% built and battle-tested — it's just dormant and single-tenant.** Engine 1 (white-label) reuses almost all of the same machinery.

**What already exists and is reusable as-is:**

- A complete, DOM-free calculation layer in `js/planning/*` (module registry, canonical household profile, per-engine adapters, routing rules, orchestrator, `result_summary`, `ireland_rules`) wrapping your real Irish-tax engines (`js/pension_math.js`, `js/net_retirement_math.js`, `js/mortgage_math.js`, `js/house_purchase/*`, `js/college_funding_math.js`, `js/liquidity_reserve.js`). This is your moat and it's already isolated from the adviser UI.
- A full consumer journey: `/plan/` UI (`js/plan/*`) and a hardened Worker service (`worker/src/consumer/*` — `router.js`, `conversation.js`, `ai_provider.js`, `analysis.js`, `handoff.js`, `repository.js` with app-encrypted D1, `session_auth.js`, `validators.js`, `cost_budget.js`, realtime voice).
- An AI intake using the OpenAI Responses API with strict-schema extraction, rules-only fallback, and per-turn/session/day cost caps.
- A **handoff** flow (`worker/src/consumer/handoff.js`) that already stores a `recipient` on each handoff row and delivers into your pipeline via a `createPipelineHandoff` callback — i.e. it was designed to be pointed at someone other than Gerry.
- Server-owned feature flags (`worker/src/consumer/config.js`): `consumerJourneyEnabled`, `consumerAiIntakeEnabled`, `consumerModuleRoutingEnabled`, `consumerHumanHandoffEnabled`, `consumerPublicAccessEnabled`, cohort.
- A defined analytics funnel (`consumer_journey_started … handoff_requested … consultation_booked … consultation_paid`) plus a privacy-first telemetry service in `services/learning-signals/` that already has a `tenant-context` notion.
- Clean, consistent server plumbing: `getRouteConfig()` + a `fetch()` dispatcher in `worker/src/index.js` that delegates `/api/consumer/*` to the consumer router; additive, forward-only migrations in `worker/migrations/*` (LEADS_DB) and `worker/consumer-migrations/*` (CONSUMER_DB); Resend email; a `scripts/build-pages.mjs` that emits `dist/` and the sitemap.

**The gaps that matter for the strategy:**

1. **No multi-tenant adviser identity.** Adviser auth is a single password/HMAC cookie for Gerry. The existing plan's "Phase 8 — Adviser network" was explicitly deferred and calls this out: *"the current single adviser password is insufficient."* This is the one foundational gap.
2. **No API-key / embed layer.** Nothing lets a third-party adviser site call your service or embed your chat. There is no per-tenant config, branding, or allowed-origins model.
3. **The handoff points only at Gerry.** `recipient` exists but there is no adviser to route to, no lead delivery to a firm, no lead billing.
4. **No commercial layer.** No Stripe, no subscription/quota, no per-lead billing, no affiliate tracking.
5. **Consumer journey is invite-only and dormant.** `consumerPublicAccessEnabled=false`, gated behind an external activation checklist (production `CONSUMER_DB`, secrets, approved policies, edge headers).
6. **The public site is positioned as "book a call with Gerry," not a content/SEO destination** with a free auto-enrolment hook.

**The single unlock:** build a **multi-tenant adviser (tenant) identity + API-key + lead-routing foundation.** That one layer turns the handoff recipient into "any firm," which is simultaneously the white-label buyer (Engine 1) and the marketplace lead-buyer (Engine 2). Everything else is reuse.

### Capability map

| Capability | Status | Action |
|---|---|---|
| Irish-tax calculation engines | Built, isolated (`js/planning/*`) | Reuse unchanged |
| Consumer AI chat + review + results | Built (`/plan/`, `worker/src/consumer/*`) | Reuse; parameterise by tenant |
| Handoff / lead package | Built, `recipient`-aware | Extend recipient → tenant |
| Feature flags + cost caps | Built (`consumer/config.js`) | Add tenant/embed/billing flags |
| Analytics funnel + telemetry | Defined + `learning-signals` | Wire dashboard |
| Multi-tenant adviser identity | **Missing** | **Build (foundation)** |
| API keys + embeddable widget | **Missing** | **Build (Engine 1)** |
| Per-tenant branding / config / origins | **Missing** | Build (Engine 1) |
| Billing (Stripe) | **Missing** | Build (Engines 1 & 3) |
| Public access + SEO/content hub | Flagged off / not built | Flip + build (Engine 2) |
| Lead marketplace routing + billing | **Missing** | Build (Engine 3) |
| Adviser-authored modules | Registry is static, code-owned (`js/planning/module_registry.js`) | Make registry data-driven; tiered authoring (WS-6) |

---

## Part B — Guardrails the agent must obey

These come straight from your own `docs/consumer-ai-journey-integration-plan.md` (§22) and must be pasted into every build prompt:

- Do **not** modify the behaviour of the existing `/app/*` adviser workflow, its auth cookie, CSRF, capability/PIN flow, or encrypted publishing. New adviser-facing admin pages may be *added* (as `/app/clients.html` was), but existing ones stay intact.
- **Additive, forward-only migrations only.** Never rewrite existing rows or alter existing table constraints. New tenant tables go in `worker/migrations/*` (LEADS_DB); consumer tables stay in `worker/consumer-migrations/*` (CONSUMER_DB).
- **One calculation source.** Reuse `js/planning/*`; never copy a formula or let AI compute financial outputs.
- **New surfaces ship behind server-owned flags defaulting to false**, following the `getConsumerConfig` pattern. Roll back by flag first.
- Follow the existing routing pattern: add methods in `getRouteConfig()` and a `pathname.startsWith(...)` delegation in the `fetch()` dispatcher to a new router module; never inline large handlers.
- Keep credential boundaries separate: adviser cookie, consumer session credential, and tenant API key are three distinct trust boundaries and must never be accepted for each other.
- Every migration needs a rollback note; every workstream ships with tests (Node `node:test` for units, Wrangler/Miniflare for Worker integration).

---

## Part C — The build, by workstream

### WS-0 — Tenant & API-key foundation (unlocks both engines)

**Goal.** Make "an adviser firm" a first-class tenant with an API key, branding/config, allowed embed origins, and a lead-routing target.

- **New migration** `worker/migrations/0015_create_advisor_tenants.sql` (LEADS_DB), additive: `advisor_tenants` (id, slug, firm_name, contact_email, status, plan, branding_json, booking_url, allowed_origins_json, created_at), `tenant_api_keys` (id, tenant_id, key_prefix, key_hash, status, last_used_at, created_at), `tenant_leads` (id, tenant_id, source ['embed'|'marketplace'], handoff_id, payload_ref, billing_status, created_at), `tenant_lead_deliveries` (idempotent receipt, mirrors existing `0014_create_consumer_handoff_deliveries.sql`).
- **New Worker module** `worker/src/tenant/router.js` + `worker/src/tenant/auth.js` (constant-time API-key hash check reusing helpers from `worker/src/consumer/crypto.js`), delegated from `index.js` via `if (pathname.startsWith('/api/tenant/'))` and method config in `getRouteConfig`.
- **New admin endpoints** under existing adviser auth: `/api/admin/tenants` (list/create), `/api/admin/tenants/:id` (update, rotate key). These sit behind the current `planeir_advisor_session` cookie + CSRF.
- **Extend the handoff recipient**: `worker/src/consumer/handoff.js` + `createConsumerPipelineHandoff` in `index.js` accept `recipient = { type: 'tenant', tenantId }` and write to `tenant_leads` + deliver to the tenant (Resend email to `contact_email`, optional webhook). Gerry remains the default recipient when no tenant is set.
- **New flags** in `consumer/config.js`: `tenantApiEnabled`, `embedEnabled` (default false).

### WS-1 — Engine 1: white-label embeddable widget (fastest revenue)

**Goal.** An adviser drops one script tag on their site; a branded Planéir planning chat appears; completed, consented plans arrive as leads to *that* firm. Sell for ~€300/mo.

- **Embed loader** `embed/v1.js` (served by the Worker or Pages): reads `data-tenant-key`, injects a sandboxed iframe to `embed/index.html?k=<publishable_key>`.
- **Embed shell** `embed/index.html` + `styles/embed.css` reusing `js/plan/*` and `js/planning/*`, with branding/booking-url/allowed-modules fetched from `GET /api/tenant/config` (API-key auth, per-tenant CORS from `allowed_origins_json`).
- **Lead delivery** reuses WS-0: on consented handoff inside an embed session, recipient = that tenant.
- **Billing** `worker/src/tenant/billing.js`: Stripe Checkout for subscription + `/api/stripe/webhook` to set `advisor_tenants.status` (active/past_due); embed refuses new sessions when not active.
- **Admin page** `app/tenants.html` (new, under adviser auth) to create tenants, issue/rotate keys, see lead counts. Does not alter existing `/app` pages.

### WS-2 — Engine 2: public consumer funnel + SEO hub

**Goal.** Turn the public site into a content/education destination that acquires consumers cheaply off the auto-enrolment wave and feeds them into `/plan/`.

- **Free hook tool**: a lightweight "My Future Fund / auto-enrolment" explainer at `/tools/auto-enrolment/` (new static page + a small calculator reusing `js/pension_math.js` through a `js/planning` adapter), CTA into `/plan/`.
- **Content hub** `/learn/*`: static article templates targeting high-volume auto-enrolment / pension / mortgage queries, with JSON-LD, canonical, OG tags; extend `scripts/build-pages.mjs` sitemap emission.
- **Landing repositioning**: `index.html`, `js/landing.js`, `styles/landing.css` — hero becomes the free tool + education, with "talk to an adviser" as the downstream CTA (keep the existing lead form working).
- **Flip to public**: prepare `consumerPublicAccessEnabled=true` and `consumerJourneyEnabled=true`, gated behind the activation checklist in `docs/consumer-ai-journey-integration-plan.md` §21 (production `CONSUMER_DB`, secrets, approved policy text, edge headers).

### WS-3 — Engine 2 monetisation: consented lead marketplace

**Goal.** When a consumer chooses to be connected, route a consented, qualified lead to a matched tenant adviser and bill for it.

- **Recipient selection**: extend the handoff consent step so the consumer consents to a *named* adviser or "match me"; matching is transparent and rules-based (geography / availability / round-robin) — no bidding, no silent recipient change (per plan §13).
- **Lead billing**: per-accepted-lead via Stripe metered usage, or against a subscription quota (Planswell-style). Track in `tenant_leads.billing_status`.
- **Affiliate hooks** (stub): a `referral_clicks` table + disclosed, consented outbound links to product providers; keep disabled until compliance signs off.

### WS-4 — Instrumentation & funnel dashboard

**Goal.** Produce the metrics a raise is judged on. The events already exist; wire them to a view.

- Ensure `recordEvent` emits the full funnel; add tenant lead metrics; expose an aggregate `GET /api/admin/metrics` (adviser auth) and a simple `app/analytics.html` funnel view (started → confirmed → analysis → handoff → booked → paid, plus white-label MRR, leads/firm, CAC by channel via UTM capture).

### WS-5 — Compliance & consent hardening (continuous)

**Goal.** Keep it on the right side of the line the FCA/Central Bank/EU-AI-Act direction implies.

- Consent scope for third-party sharing and paid referral; explicit "this is a paid introduction" disclosure; education-not-advice wording throughout; GDPR data-minimisation on shared fields; edge security headers for `/plan/*` and `/embed/*`. **Get a qualified compliance review before enabling public access or lead sale** — this is legal, not just code.

### WS-6 — Adviser module authoring (make the framework theirs)

**Goal.** Let advisers create their own modules in plain language — describe when the module applies, what to ask the client, and what it produces — and have the AI recognise the fit and collect the inputs in conversation. This turns the static `js/planning/module_registry.js` into a data-driven registry that merges built-in code-owned modules with tenant-authored ones.

> **Design boundary — read before building.** Today the AI is deliberately *not allowed to select or compute modules*: `worker/src/consumer/ai_provider.js` extracts facts and goal candidates, and deterministic code (`js/planning/routing_rules.js`, `module_registry.js`, `question_plan.js`) does the selecting and running. That invariant is the compliance moat. Adviser authoring must **extend** it, not break it. So an adviser "module" is a declarative definition with three separable parts, only one of which is risky:
>
> 1. **Intent** — a natural-language "use this when…" plus goal tags. The AI matches the client's language to the intent and *proposes* it; deterministic code still does the actual selection. Safe.
> 2. **Inputs** — declared questions, each with an NL prompt. The AI collects them conversationally; deterministic validation applies. Safe.
> 3. **Output logic** — tiered by risk:
>    - **Capture (no maths):** collect inputs → summarise → hand off to the adviser. Fully safe. **Ship this tier first** — it is ~80% of what advisers actually want (own their niche's fact-find and get the lead) and needs no calculation review.
>    - **Composed:** assemble from the *existing vetted* `js/planning/*` engines with configured assumptions. Reuses code-owned maths. Safe.
>    - **Custom (adviser formula):** a deterministic, sandboxed expression evaluated **in code, never by the AI**, kept tenant-private, labelled *"Firm's own tool — not Planéir-verified,"* and review-gated before any sharing. The genuinely risky tier — contain it.
>
> Reframe of your ask: it will *feel* like "the AI uses the module when suitable" — it recognises the fit from your description and gathers the inputs — but a deterministic rule does the selecting and any calculation. That is what stops a badly-written module from silently emitting wrong "advice" under the Planéir brand and keeps the AI-doesn't-calculate guarantee intact.

- **New migration** `worker/migrations/0016_create_tenant_modules.sql` (LEADS_DB): `tenant_modules` (id, tenant_id, slug, name, tier, status ['draft'|'active'|'disabled'], scope ['tenant_private'|'shared_pending_review'|'verified_shared'], definition_json, version, timestamps) + `tenant_module_versions` history.
- **Definition schema** (a serialized extension of the existing `PlanningModuleDefinition` in `js/planning/contracts.js`): `intent { description, goalTags[], keywords[] }`, `inputs[{ key, label, aiPrompt, type, required, validation, mapsToProfilePath? }]`, `output { tier, capture:{summaryTemplate}, composed:{engineRef, inputMapping}, custom:{expression} }`, `presentation { resultTemplate, disclosures[] }`, `compliance { educationOnly:true, verifiedByPlaneir:false }`.
- **Data-driven registry**: add a loader that merges `listPlanningModuleDefinitions()` (built-ins) with the active tenant's modules; deterministic routing maps a matched goal/intent tag → module; `question_plan.js` collects each module's declared inputs. Adviser-declared fields that do not map to a canonical profile path are stored as namespaced profile *extras* with provenance — never written into the canonical financial paths the vetted engines read unless explicitly mapped.
- **AI wiring**: pass the active tenant's `intent.description` texts into the `ai_provider.js` extraction context so the model can propose matching intent tags; keep the hard rule that the model never returns module IDs or computes outputs.
- **Authoring UI** `app/modules.html` (new, adviser auth): a plain-language builder — name → "describe when to use this" → "the questions to ask the client (label + how the AI should ask + answer type)" → "what it produces (capture & summarise for me / use a Planéir calculator / advanced)" → preview + test-chat → save draft/active. Scope defaults to `tenant_private`.
- **Governance**: capture and composed tiers are self-activatable within a tenant; custom requires explicit acknowledgement, is labelled unverified, and is blocked from `verified_shared` without a Planéir review; the shared consumer marketplace runs only `verified_shared` modules (adviser custom modules run only inside that adviser's own white-label embed); a prohibited-field list (no PPS numbers, account numbers, credentials); disclosure injection; versioning, effective dates, and a kill switch; reuse the existing education-not-advice validator.

---

## Part D — Sequencing (and why)

Build in this order so revenue and de-risking come early and you're unblocked to sell:

1. **WS-0 → WS-1 first.** The white-label is your fastest, contracted, no-CAC revenue and it proves the tenant foundation. Once WS-1 ships you can *sell the API* to Brokers Ireland firms while everything else is still being built. This is the "easier initial revenue" you wanted.
2. **WS-2 next.** Public funnel + SEO + free tool — this is what lets you *do content and drive consumer use*. It can proceed in parallel with WS-1 since it mostly touches the public site and flags.
3. **WS-3** once WS-0 tenants exist and WS-2 is bringing traffic — turn consumer volume into paid leads.
4. **WS-6 (adviser module authoring) rides alongside WS-1.** Ship the *capture* tier first — it needs no calculation review, and "make it their own" is a core white-label selling point that helps close design-partner firms. Composed and custom tiers follow behind review gates.
5. **WS-4 and WS-5 continuously**, but WS-5's compliance sign-off is a hard gate before WS-2 public launch, WS-3 lead sale, and any *shared* (marketplace) use of adviser-authored modules.

This maps directly to the blended plan: WS-1 = Engine 1 revenue (Year 1 backbone); WS-2/WS-3 = Engine 2 scale.

---

## Part E — The build prompts (copy-paste, in order)

Hand these to your coding agent one at a time. Each is self-contained. **Prepend the Part B guardrails to every prompt** (or tell the agent to read `docs/consumer-ai-journey-integration-plan.md` §22 first). Each prompt ends by requiring tests and a rollback note.

---

**P1 — Tenant data model (WS-0)**

> In the Planéir repo, add a new additive, forward-only migration `worker/migrations/0015_create_advisor_tenants.sql` for the `LEADS_DB` binding. Create tables: `advisor_tenants` (id TEXT PK, slug TEXT UNIQUE, firm_name, contact_email, status TEXT default 'pending', plan TEXT, branding_json TEXT, booking_url TEXT, allowed_origins_json TEXT, created_at, updated_at); `tenant_api_keys` (id PK, tenant_id FK, key_prefix, key_hash, status default 'active', last_used_at, created_at); `tenant_leads` (id PK, tenant_id FK, source TEXT check in ('embed','marketplace'), handoff_id, payload_ref, billing_status default 'unbilled', created_at); `tenant_lead_deliveries` (idempotent receipt, model it on the existing `worker/migrations/0014_create_consumer_handoff_deliveries.sql`). Do not modify existing tables. Add a rollback note. Follow the conventions in the existing migration files exactly.

**P2 — Tenant API-key auth + router (WS-0)**

> Create `worker/src/tenant/auth.js` and `worker/src/tenant/router.js`. `auth.js` validates a tenant API key from the `Authorization: Bearer pk_…` header by constant-time comparing its SHA-256 against `tenant_api_keys.key_hash` (reuse `constantTimeEqual`/`sha256Base64Url` from `worker/src/consumer/crypto.js`), loads the tenant, and rejects if tenant status is not 'active'. `router.js` exposes a `handleTenantRequest(request, env, ctx)` dispatcher mirroring the structure of `worker/src/consumer/router.js`. In `worker/src/index.js`, register method config in `getRouteConfig()` for `/api/tenant/*` and add `if (pathname.startsWith('/api/tenant/')) { const { handleTenantRequest } = await import('./tenant/router.js'); return handleTenantRequest(...); }` in the `fetch()` dispatcher, following the exact pattern used for `/api/consumer/`. Add `tenantApiEnabled` and `embedEnabled` flags (default false) to `worker/src/consumer/config.js`. Enforce per-tenant CORS using `allowed_origins_json`. Add Miniflare integration tests and a rollback note. Do not change any existing route.

**P3 — Admin tenant management endpoints + page (WS-0/WS-1)**

> Add adviser-authenticated endpoints (existing `planeir_advisor_session` cookie + `X-Advisor-CSRF`): `GET/POST /api/admin/tenants`, `GET/PATCH /api/admin/tenants/:id`, and `POST /api/admin/tenants/:id/rotate-key` (returns the key once, stores only the hash). Register them in `getRouteConfig()` and the dispatcher. Create a new page `app/tenants.html` + its JS, modelled on `app/clients.html`, to create tenants, issue/rotate keys, set branding/booking-url/allowed-origins, and view per-tenant lead counts. Do not modify existing `/app` pages or handlers. Tests + rollback note.

**P4 — Route the handoff to a tenant (WS-0)**

> Extend `worker/src/consumer/handoff.js` and `createConsumerPipelineHandoff` in `worker/src/index.js` so a handoff `recipient` may be `{ type: 'tenant', tenantId }` in addition to the current Gerry default. When recipient is a tenant: write a `tenant_leads` row, deliver to the tenant's `contact_email` via the existing Resend helper, and optionally POST to a tenant webhook. Preserve all existing consent, confirmation-required, retention and idempotency behaviour. Default recipient remains Gerry when no tenant is supplied. Add tests covering both recipients and the idempotent delivery receipt. Rollback note.

**P5 — Tenant config endpoint (WS-1)**

> Add `GET /api/tenant/config` to `worker/src/tenant/router.js` (API-key auth). Return only public, tenant-scoped fields: firm display name, branding (logo URL, colours), booking URL, and the allowlisted consumer module IDs for this tenant. Reuse the allowed-module logic from `worker/src/consumer/config.js`. No secrets in the response. Tests + rollback note.

**P6 — Embeddable widget shell (WS-1)**

> Create an embeddable widget: `embed/v1.js` (a small loader that reads `data-tenant-key` from its own script tag and injects a sandboxed iframe to `embed/index.html?k=<key>`), `embed/index.html`, and `styles/embed.css`. The iframe reuses the existing `js/plan/*` consumer UI and `js/planning/*` engines, but themes itself from `GET /api/tenant/config` and runs the consumer journey scoped to the tenant. Sessions started in the embed set handoff recipient = that tenant (P4). Enforce the tenant's `allowed_origins`. Update `scripts/build-pages.mjs` to emit `embed/` into `dist/` with versioned assets. Keep it behind `embedEnabled`. Do not alter `/plan/` or `/app/`. Add an E2E test that loads the embed against a test tenant. Rollback note.

**P7 — Stripe subscription for white-label tenants (WS-1)**

> Add `worker/src/tenant/billing.js`: a Stripe Checkout flow to start a tenant subscription and a `POST /api/stripe/webhook` handler (signature-verified) that updates `advisor_tenants.status` (active/past_due/canceled). The embed and `/api/tenant/*` must refuse new sessions when status !== 'active'. Store Stripe IDs on the tenant. Put Stripe keys in Worker secrets (never in git); document them in `README.md` alongside the existing Resend/Zoom secrets. Tests with a mocked Stripe signature. Rollback note.

**P8 — Free auto-enrolment hook tool (WS-2)**

> Create a public, no-login "My Future Fund / auto-enrolment" explainer at `/tools/auto-enrolment/` (new static page + JS). It must reuse `js/pension_math.js` via a `js/planning` adapter — no new or duplicated financial formulas. It computes a simple illustrative projection, uses education-not-advice wording, and CTAs into `/plan/`. Add SEO metadata (title, description, canonical, OG, JSON-LD) and include it in `scripts/build-pages.mjs` + `sitemap.xml`. Tests for the calculation adapter parity against the engine. Rollback note.

**P9 — Content/SEO hub (WS-2)**

> Add a `/learn/` content section: a static article template with strong SEO metadata (canonical, OG, Twitter, JSON-LD Article), an index page, and 3 seed articles targeting auto-enrolment / pension / first-home queries, each linking to the free tool and `/plan/`. Extend `scripts/build-pages.mjs` to build `/learn/*` and add them to `sitemap.xml` with versioned assets. Do not touch `/app/`. Rollback note.

**P10 — Reposition the landing page (WS-2)**

> Update `index.html`, `js/landing.js`, and `styles/landing.css` so the hero leads with the free auto-enrolment tool and education, with "talk to an adviser / book a call" as a secondary CTA. The existing `POST /api/leads` form and its consent fields must keep working unchanged. Keep `/app` untouched. Add/adjust the landing smoke test. Rollback note.

**P11 — Public-access activation checklist (WS-2/WS-5)**

> Do not flip any production flag. Instead, produce `docs/consumer-public-activation-checklist.md` enumerating exactly what must be true to set `CONSUMER_JOURNEY_ENABLED=true` and `CONSUMER_PUBLIC_ACCESS_ENABLED=true` in production, based on `docs/consumer-ai-journey-integration-plan.md` §21 (isolated production `CONSUMER_DB`, protected secrets, approved consent/privacy/AI/handoff policy text and durations, edge-enforced CSP/frame-ancestors/HSTS headers for `/plan/*` and `/embed/*`, staged cohort). Wire the edge security headers for `/plan/*` and `/embed/*`. Leave flags false.

**P12 — Consented marketplace routing (WS-3)**

> Extend the handoff consent step in `worker/src/consumer/handoff.js` and the `/plan/` UI so a consumer can consent to a *named* adviser or choose "match me". Implement transparent, rules-based matching (geography / availability / round-robin over active tenants) with no bidding and no silent recipient change (per integration-plan §13). Route the resulting lead via P4. Record the exact shared field paths and recipient in the consent record. Tests for consent scope and matching determinism. Rollback note.

**P13 — Lead billing for marketplace (WS-3)**

> Add per-lead billing for `source='marketplace'` `tenant_leads`: either Stripe metered usage or decrement of a subscription quota, configurable per tenant. Update `billing_status` on delivery. Surface lead counts and spend on `app/tenants.html` and `app/analytics.html`. Tests for the billing state machine. Rollback note.

**P14 — Funnel & revenue dashboard (WS-4)**

> Confirm the consumer funnel events (`consumer_journey_started … handoff_requested … consultation_booked … consultation_paid`) all emit via `recordEvent`, add UTM capture on `/plan/` and the embed for CAC-by-channel, and expose `GET /api/admin/metrics` (adviser auth) aggregating: consumer funnel conversion, white-label MRR and active tenants, leads per firm, and channel mix. Build a simple `app/analytics.html` to visualise started → confirmed → analysis → handoff → booked → paid plus the B2B metrics. Reuse the `services/learning-signals` telemetry where sensible. Tests + rollback note.

---

### Adviser module authoring prompts (WS-6)

**P15 — Adviser module data model & definition schema**

> Add additive migration `worker/migrations/0016_create_tenant_modules.sql` (LEADS_DB): `tenant_modules` (id, tenant_id FK, slug, name, tier check in ('capture','composed','custom'), status check in ('draft','active','disabled') default 'draft', scope check in ('tenant_private','shared_pending_review','verified_shared') default 'tenant_private', definition_json, version int, created_at, updated_at) and `tenant_module_versions` (module_id FK, version, definition_json, created_at). In `js/planning/contracts.js`, add the adviser-module constants (tiers, scopes) and a validator for the definition schema: `intent {description, goalTags[] (subset of GOAL_TYPES), keywords[]}`, `inputs[{key,label,aiPrompt,type,required,validation,mapsToProfilePath?}]`, `output {tier, capture:{summaryTemplate}, composed:{engineRef,inputMapping}, custom:{expression}}`, `presentation {resultTemplate,disclosures[]}`, `compliance {educationOnly:true, verifiedByPlaneir:false}`. No behaviour change yet. Tests for schema validation + rollback note.

**P16 — Data-driven registry & capture-tier routing**

> Make `js/planning/module_registry.js` data-driven: keep every existing built-in `register(...)` definition unchanged, and add `mergeTenantModules(tenantModules)` that validates and merges a tenant's authored definitions into the selectable set (built-ins win on ID collision). Extend `js/planning/routing_rules.js` so a matched goal/intent tag can resolve to an adviser **capture**-tier module, and `js/planning/question_plan.js` so a module's declared `inputs` become the questions to collect. Store adviser-declared fields without a `mapsToProfilePath` as namespaced profile extras with provenance; never write them into canonical financial paths. Implement only the capture tier (collect → summary template → handoff); no calculation. Golden tests: a sample tenant capture module is selected for its intent, its inputs are asked, its summary renders. Rollback note.

**P17 — AI intent-matching & conversational input collection**

> Wire adviser-module intent into the AI without letting the model select or compute. In `worker/src/consumer/ai_provider.js`, include the active tenant's module `intent.description` texts in the extraction context so the model can propose matching *intent tags* alongside existing goal candidates; keep and re-assert the hard rule that the model never returns module IDs, chooses analyses, or produces financial numbers. In `worker/src/consumer/conversation.js`, ensure the deterministic path maps a proposed intent tag → adviser module via the registry and drives input collection from the module's declared `inputs` using their `aiPrompt`. Tests: intent match proposes the module deterministically; malformed/oversized model output falls back to rules-only; the model cannot force-select a module. Rollback note.

**P18 — Plain-language authoring UI & CRUD**

> Add adviser-authenticated CRUD endpoints for `tenant_modules` (`GET/POST /api/admin/modules`, `GET/PATCH/DELETE /api/admin/modules/:id`, `POST /api/admin/modules/:id/activate`) in the tenant/admin router, and a new page `app/modules.html` (modelled on `app/clients.html`, existing adviser auth): a plain-language builder — name → "describe when to use this (client goals/situations)" → "questions to ask the client (label + how the AI should ask + answer type)" → "what it produces (Capture & summarise for me / Use a Planéir calculator / Advanced)" → live preview + a test-chat against the tenant journey → save as draft/active. Default scope `tenant_private`. Validate against the P15 schema; enforce the prohibited-field list (no PPS/account numbers/credentials) and inject the education-not-advice disclosure. Do not modify existing `/app` pages. Tests + rollback note.

**P19 — Composed & custom tiers + governance**

> Add the **composed** tier: an adviser assembles a module from the existing vetted `js/planning/*` engines by choosing an `engineRef` and mapping declared inputs to that engine's input schema; the engine — not the adviser, not the AI — computes. Add the **custom** tier: a deterministic, sandboxed expression evaluator (a small allowlisted arithmetic/logic mini-language — **no `eval`, no JS execution, never the model**) over the collected inputs; custom modules are forced `tenant_private`, rendered with a persistent *"[Firm]'s own tool — educational, not Planéir-verified"* label, and cannot be set to `verified_shared` without a Planéir review flag. Enforce: the shared consumer marketplace only runs `verified_shared` modules; versioning writes `tenant_module_versions`; a per-module kill switch; reuse the education-not-advice validator on all rendered output. Tests: engine parity for composed; sandbox rejects arbitrary code; custom modules blocked from marketplace scope. Rollback note.

---

## Part F — What you own vs. what the agent owns

So you can stay in your lane while this gets built:

**Your focus (no code):** creating the `/learn/` content and the auto-enrolment explainers; recruiting the first 5–10 white-label design-partner firms from your network to sell P6/P7 to; running consumer education/social; and commissioning the compliance review (WS-5) — that one's a real lawyer, not the agent.

**The agent's focus (the prompts):** WS-0 → WS-1 to get you something to sell within weeks, then WS-2 to give you a place to send content traffic, then WS-3/WS-4.

**First milestone to aim for:** P1–P7 shipped = a sellable white-label product with billing, on top of the calculation engine you already own — your Engine 1 revenue line, live, while the consumer funnel is still warming up.

---

*Design notes are grounded in the current repo (`worker/src/index.js`, `worker/src/consumer/*`, `js/planning/*`, `docs/consumer-ai-journey-integration-plan.md`). Nothing here modifies existing `/app/*` behaviour. Not legal advice — the consent, financial-promotion and lead-sale elements need qualified compliance sign-off before go-live.*
