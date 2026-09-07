# Backend validation — 7 September 2026

The integration harness uses the production Durable Object implementation, migrated SQLite/D1 adapter, encrypted repositories, certificate checks, execution service and existing financial engines. Its provider responses are scripted. It does not prove that a real model chooses the scripted tools, that real audio was delivered, or that production latency is acceptable.

`scripts/check-live-completion-matrix.mjs` completed **160/160** cases: 80 Speak and 80 Type, producing **80 identical result pairs**. The scenarios include every approved module, mixed analyses, a broad check-up and a correction before read-back, each using eight approval forms. The Type cases call the actual typed renderer and shared tool dispatcher. Each case authenticates the certified input, approves, runs the real engines, reads the persisted results, repeats approval and reconstructs the coordinator before another receipt replay. There were **zero duplicate calculations and zero approved/executed input hash mismatches**. Only execution-specific IDs/timestamps are removed before comparing native results; inputs, outputs, warnings, assumptions, versions and input hashes must agree.

That expansion found a Type-specific defect: ordinary assistant replies after a read-back did not pass through the shared confirmation-continuation method. The offer lost its reply binding, so a repeated legitimate approval returned `confirmation_context_invalid`. Every completed Type assistant turn now uses the same continuation method as Speak; that method still distinguishes continuation from new certified delivery.

Additional permanent composed regressions:

| Script | Evidence |
| --- | --- |
| `check-first20-execution-recovery.mjs` | Seven cases; six failed on the original baseline. Exact-once read-back persistence, approval reply binding after eviction, typed idle/heartbeat policy, both shutdown paths and voice fail-closed termination. |
| `check-first20-router-recovery.mjs` | Seven authenticated handler/D1 cases: startup rollback, budget release, activation replay, terminal state access, retryable closure, updated disclosures, withdrawn consent and hard expiry. Coordinator behavior is injected; no provider request occurs. |
| `check-first20-typed-recovery.mjs` | Pending typed channel, persisted public transcript/card, and stale-card binding with eviction and repeated acknowledgement. |
| `check-first20-verifier-rejection.mjs` | Three checks: a delivered €240,000 mortgage plan, a later €340,000 correction missed by the extractor but rejected by the verifier, and refusal of both the old offer and direct execution. No analysis row is created. |
| `check-live-certified-approval.mjs` | Certified-offer handling and the corrected expectation that a new verifier rejection cannot be ignored because numbers match an old certificate. |
| `check-first20-typed-unknown-resolution.mjs` | Eighteen assertions through actual typed ingest, card binding, durable uncertainty, eviction, a valid rejected semantic audit, later certified resolution and one real engine result. |
| `check-first20-planner-diagnostics.mjs` | Seven provider-boundary checks: 401, 429, 500, network failure, invalid JSON, incomplete output and a stalled response body. Telemetry retains stage/status/IDs/version/latency and excludes financial content, provider error text and credentials. |

## Card action integrity

The old opaque card ID was positional: `f0_0` could mean interest rate in one brief and balance in the next. A stale “Not sure” action could therefore acknowledge the wrong requirement. The new regression reproduced that collision before the fix (`diagnostics/first20/baseline/stale-card-before.log`).

`projectTypedBrief` now builds the public fields and private action index together. A field's draft identity is an opaque hash of the private session/lease, native field and enclosing record identity. It stays stable for the same field during a midway question and changes when the field or owner record changes. Its “Not sure” action separately hashes the exact persisted brief, so an older action cannot resolve through a newer card. The same stored brief reproduces its IDs after eviction. No additional persistence layer or financial interpretation was added; module names, native paths and snapshot revisions remain private.

A repeated uncertainty action updates its durable source turn. The certificate-consuming code only removes a matching original source, so an older in-flight resolution cannot clear the newer acknowledgement. An exact retry of the same source is a no-op.

## Operational diagnostics and limits

Direct planner provider failures now attach internal stage, model/prompt version, HTTP status, provider/client request IDs and elapsed time. The existing event allowlist retains only those scalar operational fields. Public error wording stays generic. The abort deadline now covers body consumption as well as response headers; previously a stalled body could outlive the request deadline.

This is not complete cost/trace observability. Failed or incomplete responses and failures during a best-effort repair are not yet represented by a comprehensive per-call billing ledger. A generic 429 remains distinguishable by status/request ID but does not classify quota versus rate limiting. Normal semantic rejections are visible in the encrypted brief and verdict events; ordinary events intentionally contain no raw conversation. Provider prices use the existing configured provisional metering path, not a freshly audited pricing model.

The local Worker HTTP suite passed separately against the migrated local D1 bindings. Static build and Worker dry-run packaging passed; no deployment command without `--dry-run` was used. Final aggregate test results and the real-model outcomes belong to [the readiness report](first20-readiness.md). A passing simulated execution matrix must not be presented as seven successful real voice conversations.
