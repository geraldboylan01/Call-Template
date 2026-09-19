# Planéir: first 20 consumer readiness

Audit started 5 September 2026; final validation continued 7 September. No production deployment was performed. The preserved starting commit is `3a85575427aa1db229afa27b53a3edf0b029fa31`. Subsequent commits through `382832a` arrived during this continuing audit and were preserved and independently retested. Remaining changes are reviewable in the working tree.

**Recommendation: NOT READY.** The final v9/v6 real-model run passed 9/12 cases, with remaining personal-balance-sheet, college and house-purchase completion failures. Pension and acknowledged-unknown recovery now pass, but success varies across attempts. The passing 160-case simulated execution matrix does not erase these failures. Real voice/device checks are also outstanding. This report separates deterministic execution evidence, real-model semantic evidence, and actual browser evidence; none substitutes for the other two.

## What was preventing reliable completion

The financial engines were not the principal problem. A complete client conversation could fail between understanding, confirmation delivery and recovery. The original full consumer suite passed, yet new composed tests reproduced duplicate typed confirmation persistence, lost approval binding after Durable Object eviction, Type entering voice-specific expiry/shutdown, acknowledged unknowns disappearing, and incorrect accounting of repaired model calls.

Further tests found failed Type creation stranding its lease or budget, creation replay opening no usable recovery path, closed meetings becoming unreadable, stale consent allowing typed dispatch, browser refresh losing the active Type meeting, and a lost approval response failing to reveal the completed results. A proposed shortcut that retained an old certificate despite a newer verifier rejection could execute an old mortgage balance after a correction. That shortcut was removed and is now explicitly regression-tested.

Real OpenAI evaluations exposed a different problem: correct figures can remain unconfirmable because the planner mis-cites the transcript, includes legacy input fields it cannot support, or omits material details from its read-back. A repair that receives only the auditor's findings can fix those details while dropping previously correct ones. These are semantic-production failures, even when the engines and simulated transport tests pass.

## The intended architecture and journey

Entry validates the invitation/session, disclosures, availability and budget. Speak and the new consumer Type lane both enter `ConsumerLiveSession`. They persist client turns and call the same direct-module interpreter, module contracts, policy envelope, verifier and execution service. Type's Responses renderer presents language and tools; Speak presents audio through Realtime. The older adviser agent/V2 test transport is a separate, archived planning path and cannot establish consumer Type parity.

The direct interpreter builds `MeetingBriefV3`: relevant modules, exact native inputs, evidence, missing information, ambiguity and acknowledged unknowns. Structural normalization enforces contracts and policy. The independent semantic verifier audits the inputs and exact confirmation wording against the conversation. Only a passing audit produces an authenticated certificate bound to the inputs, profile evidence/revision, policy, module/prompt versions, date, read-back and unknown-state transitions.

The server freezes the certified plan. Speak needs matching completed transcript/audio delivery; Type persists the exact certified read-back once and binds the next client answer to that assistant turn. Explicit approval must address the current offer. The execution service authenticates the latest matching certificate and frozen inputs, runs the existing engines, persists one analysis and per-module results, and returns an idempotent receipt. The browser observes the matching plan/revision/analysis, renders results and closes the correct transport. Recovery must preserve these identities rather than creating a new financial interpretation.

No financial-language regex compiler, alternate Type planner or engine changes were introduced. Existing approval grammar remains a structural confirmation gate. No new financial assumptions were approved in this audit.

## Risk-ranked map

Severity describes the possible consumer effect. “Fixed” means the stated regression passes locally; it is not a production rollout assertion.

| Area | Severity and reproduced finding | Resolution / remaining evidence |
| --- | --- | --- |
| 1. Semantic correctness | **P0:** a known unknown could vanish when the model omitted it from `missing`. **P1:** later confident answers could never resolve it; bad quotations and legacy pension fields blocked complete inputs. | Server-derived blocking, chronological evidence-bound resolution, independent verification and certificate binding. Native pension guidance and one bounded structural/semantic repair. Live semantic reliability remains a release gate. |
| 2. Conversation quality | **P1/P2:** asking again for an already supplied or explicitly unavailable answer; short read-backs omitted material assumptions; repairs dropped other correct details. | Unknowns leave the ask list. Repairs see the failed proposal and preserve supported content. The word target is a preference, with material coverage taking precedence. Model wording and repair robustness still require live evidence. |
| 3. Speak reliability | **P1:** transport invariants can break despite green legacy tests; natural approval variants were excluded. | Shared approval/read-back tests and 80 spoken simulations pass. Real ASR, interruption, audio delivery, microphone denial and reconnection remain untested in this audit's final browser run. |
| 4. Type reliability | **P1:** startup/refresh/lost response could strand the journey; post-read-back replies lost offer binding. **P0/P1:** stale positional card IDs could acknowledge a different requirement. | Idempotent activation recovery, durable state reads, guarded controller lifecycle, execution observation and shared assistant finalization. Opaque field/entity draft identities and separate exact-brief action bindings reject stale actions and survive eviction. Actual browser recovery passes with a synthetic backend. |
| 5. Speak/Type parity | **P1 evidence gap:** the original parity proof stopped during collection and the completion matrix exercised Speak alone. | Expanded to 160 actual shared-DO/SQLite executions, 80 in each transport, comparing exact native inputs and persisted engine results for 80 pairs. Provider decisions are scripted; wording/ASR equivalence is not claimed. |
| 6. Verification/certification | **P0:** ignoring a fresh verifier rejection because input numbers equal an old plan defeats the independent audit. | Removed that bypass. Both the DO and execution service reject the stale plan; correction test creates no financial run. Resolution claims are signed and checked against the actual snapshot. |
| 7. Confirmation/execution | **P0/P1:** duplicate persisted read-backs and lost assistant identity could detach approval from the displayed plan or refuse legitimate approval. | One persisted identity, storage restoration, shared continuation binding, exact frozen execution hashes and replay receipts. Zero duplicate calculations in the 160-case matrix. |
| 8. Engine input integrity | **P0:** ownership, scale, corrections and hypothetical facts belong upstream of mathematics. Unsupported provenance must not be silently accepted. | No changes to the seven engines. Native contracts, policy checks, certificates and independent audits remain enforced. Existing engine audits and 45 house-purchase checks pass. This is not an independent reapproval of financial assumptions or current statutory rules. |
| 9. Completion/results | **P1:** a lost response hid results; stale results could be mistaken for current completion; reload could reopen the journey. | Poll authenticated durable state and require current plan/revision/analysis identity. Completed sessions reload directly into results. Tested in the controller and an actual browser. |
| 10. Session lifecycle | **P1:** Type entered voice heartbeat/hang-up logic; failed activation retained reservation; terminal reads/close were not recoverable. | Explicit persisted channel, typed hard expiry, appropriate shutdown, budget compensation, authenticated terminal state and retryable closure. Consent/version/expiry tests block further dispatch. |
| 11. Browser/mobile UX | **P1/P2:** stale asynchronous responses, consent withdrawal and deletion could leave an incoherent screen. | Twenty-one focused frontend regressions; browser refresh, card recovery, lost approval and results checks; 390×844 layout without horizontal overflow. Real device keyboards, screen readers, denied storage and Safari remain manual checks. |
| 12. Observability | **P2:** generic direct-planner failures concealed the provider stage/status/request identity; early evals discarded the raw rejection. **P1:** the timeout stopped at response headers. | Content-free error metadata now survives the event allowlist; request deadline covers the body. Seven failure/privacy checks pass. Synthetic runner preserves raw provider responses and assertions. Comprehensive billing/repair-failure tracing remains incomplete; see [backend validation](first20-backend-validation.md). |
| 13. Eval coverage | **P1 evidence gap:** a green aggregate suite included legacy/source-contract checks and did not establish real consumer semantics. | Preserved green baseline plus failing new regressions; permanent real-model corpus and actual shared-service parity. Twelve cases and one run are not a statistical first-20 reliability claim. |
| 14. Release/operations | **P1/P2:** Type entry and rollback probes needed to understand the chooser; static Pages publishing did not depend on relevant consumer UI recovery checks. | Entry contract/proof updated, rollback disables Type, and Pages build now gates entry/recovery/results checks. Feature activation and production deployment remain explicit release actions. |

## Significant implementation decisions

| Decision | Why it generalizes |
| --- | --- |
| Preserve a single shared planner and execution barrier. | Transport changes cannot redefine financial meaning or calculation inputs. |
| Use the existing encrypted brief/transcript for Type recovery. | Refresh and terminal observation recover the same meeting without a second state authority or provider call. |
| Identify activation before reserving budget; compensate failed startup. | Lost HTTP responses and coordinator failures cannot consume another allowance or strand the only session slot. |
| Persist the source client turn for “Not sure”; require later evidence plus independent verification to resolve it. | A real answer can change the state while old, hypothetical, adviser-authored or still doubtful values cannot clear it. |
| Give structural provenance and semantic repairs one shared attempt. | Fix planner bookkeeping without an unbounded paid retry loop or asking the client to repair citations. Every successful provider response is metered once, including discarded repairs and cached tokens. |
| Give that repair the current failed proposal. | Correcting a citation or read-back omission should preserve previously supported details, rather than regenerate the entire plan from findings alone. |
| Distinguish the original uncertainty turn from the resolving answer in the verifier protocol. | `sourceTurnId` refers to the original acknowledgement; `turnId` refers to its later answer. An explicit protocol definition prevents the verifier incorrectly demanding that both IDs identify the answer. |
| Require actual numeric material assumptions in the read-back. | “Standard growth” cannot let a consumer check the growth rate. The values still come only from the approved policy/input; no scenario constants were added. |
| Separate stable draft identity from the current card's action binding. | Midway questions preserve unfinished input, while stale “Not sure” actions cannot move to a different field or a newer brief. |
| Reaudit the exact delivered read-back for unchanged candidate inputs. | Equal numbers do not establish unchanged ownership or certainty. Only a fresh passing certificate preserves the offer. |
| Keep expected financial outcomes unchanged. | The new explicit-ownership mortgage case supplements the original; it does not replace its failure. The corrected test expectation is the old test that explicitly demanded overriding a verifier rejection. |

## Evidence and how to reproduce it

Baseline source and logs are under `diagnostics/first20/baseline/`. Diagnostics are intentionally gitignored and contain only invented eval data for these runs. Preserve that folder when reviewing the work. Permanent regression scripts and this report are ordinary repository files. The initial source can also be reconstructed with `git archive 3a85575427aa1db229afa27b53a3edf0b029fa31`.

| Evidence | Result / interpretation |
| --- | --- |
| Original `npm run check:consumer` on pristine baseline | Passed. `baseline/check-consumer-pristine.log`. This did not catch the new composed defects. |
| New execution recovery tests on baseline | 6 failures, 1 pass. `baseline/execution-repro.log`. |
| New semantic integrity tests on baseline | 4 failures, 1 pass. `baseline/semantic-repro.log`. |
| Router reproductions before fixes | First 5 cases failed; 2 additional consent/expiry cases then failed before their fix. `baseline/router-before.log`, `baseline/router-consent-before.log`. |
| Shared completion matrix | 160/160; 80 Type/Speak result pairs; zero duplicate calculations or input-hash mismatches. `completion-parity-final.log`. Local timings are not production latency evidence. |
| Typed unknown composed recovery | 18 assertions: card → durable acknowledgement → eviction → rejected resolution → certified later answer → one actual calculation. `typed-unknown-final.log`. |
| Frontend | 21/21 focused checks plus existing voice/completion contracts. The final added check verifies the current card action token is sent while draft identity stays stable. See [frontend audit](first20-frontend-audit.md) and [browser validation](first20-browser-validation.md); the actual browser run preceded this token-only correction. |
| Real local Worker HTTP | Session isolation, consent, revision, analysis, handoff and lifecycle checks passed against local migrated D1. `http-final.log`. Type route recovery additionally uses real D1 and an injected coordinator. |
| Financial engines | Full consumer engine audits plus house-purchase 45/45. No engine edits. |

The final `npm run check:consumer` completed with exit 0 after all fixes (`check-consumer-release-final.log`). The house-purchase suite, local HTTP checks, static build and Worker dry-run also passed. [The evidence manifest](first20-evidence.json) records exact working-file and log hashes, configurations and every paid case outcome.

Run the free suite with `npm run check:consumer` and `npm run check:house-purchase`. New focused cases are included in `npm run check:first20`. The 160-case matrix belongs to `check:consumer-live`, also included in the aggregate gate. Build with `npm run build`; Worker packaging is validated using `wrangler deploy --dry-run`, which does not deploy.

The separately paid command is `npm run evals:first20`. It requires an authorized project key. `FIRST20_SOURCE_ROOT` selects a preserved source checkout; `FIRST20_OUTPUT_DIR` selects a fresh evidence folder; `FIRST20_CASES` selects exact scenario IDs. `--list` makes no provider request. Expectations never enter provider prompts. The runner uses the chosen source's prompt versions and, from the v8 run onward, its default 30-second per-call timeout. Earlier baseline/current/v7 runs used a diagnostic 120-second timeout and must not be used to claim production latency.

## Seven-module real semantic evidence

The corpus tests actual OpenAI extraction, independent verification, certificate authentication and native engines. It does not run microphone audio or the conversational renderer. The separate 160-case matrix proves integration with scripted model decisions. Their combined coverage is useful but is not seven unscripted end-to-end live conversations.

| Module | Realistic behavior exercised | Preserved baseline | v7 final-pass attempt |
| --- | --- | --- | --- |
| Personal balance sheet | Partners; similarly named accounts; corrected cash; hypothetical inheritance excluded; explicit assets/debts closure | Pass; net worth €530,000 | Pass |
| Liquidity | Separate/joint cash; correction; question mid-collection; non-cash assets excluded | Pass; €33,000 / €3,200 monthly spending | Provider/network timeout |
| Mortgage | Corrected rate; hypothetical rate excluded; annual overpayment; joint ownership | Blocked by verifier | Original case: provider/network timeout; explicit-owner case: read-back repair still blocked |
| Loan | Similar car loans; correct owner; changing annual overpayment; exclude partner loan/mortgage | Pass | Pass |
| Pension | Distinct partner pots/contributions; corrected pot; gross target/year; state pension assumptions; explicit income closure | Blocked before verification | Native inputs supported; confirmation repair still blocked |
| College | Anna versus Anne; corrected age; different start ages/durations; unknown residence keeps all standard scenarios | Pass | Pass |
| House purchase | Joint incomes/separate savings; protected funds; corrected price; unknown scheme facts; no confirmed support | Blocked before verification | Still blocked by invalid evidence citations after repair |

Preserved run totals: `paid-baseline` **6/11**; `paid-current` **7/11**; `paid-final` (v7/v4, including the extra mortgage case) **7/12**; `paid-v8` **9/12**; `paid-v9` **9/12**. These totals include safe negative cases, not just completed modules. The extra explicit-owner case is separate; on the original 11-case subset the v9 result is **8/11**. Earlier failures remain part of the reliability record. No financial expectation was relaxed.

The latest v9/v6 result, using the existing model with low reasoning and the source's 30-second per-call deadline, is:

| Case | Latest result |
| --- | --- |
| Personal balance sheet | **Fail:** the model labeled client-supplied monthly expenditure as an unapproved policy assumption; normalization refused it. Earlier runs passed the same unchanged expectation. |
| Liquidity | **Pass:** corrected €33,000 cash and spending; certified native engine results. |
| Mortgage, original and explicit ownership | **Both pass:** corrected 4.1% rate, €240,000 balance and €500 annual overpayment; hypothetical 6% excluded. |
| Loan | **Pass:** only the requested owner's loan and corrected overpayment; certified results. |
| College | **Fail:** correct child ages and inputs, but the record-level quotation still carried the superseded age. Structural repair had already used the bounded attempt; the verifier demanded clarification. |
| Pension | **Pass:** corrected partner pot/contributions, gross target and numerical material assumptions; certified results after four calls, 52.5 seconds overall. |
| House purchase | **Fail:** numeric inputs supported after evidence repair, but the read-back omitted material cash-flow inputs and financial assumptions. Three calls took 55.8 seconds; no certificate or execution followed. |
| Open PBS collection; doubtful mortgage rate; acknowledged unavailable rate | **All three correctly blocked.** No certificate. |
| Later confident rate resolves earlier uncertainty | **Pass:** explicit resolution protocol, authentic certificate and native result. |

A diagnostic v8 medium-reasoning comparison on pension and house purchase passed **0/2**: pension remained uncertified and house purchase hit its 30-second timeout. More reasoning alone is therefore not an evidenced fix; the default remains low. The v9 paid run loaded before the final body-deadline/diagnostic wrapper correction; that correction has separate deterministic timeout tests and changes no prompt or financial interpretation.

Remaining P1 work is demonstrated, not hypothetical: live extraction/verification must reliably complete the same fully supplied PBS/college/house cases, without making the client repair evidence bookkeeping. There is also a deadline mismatch to resolve and exercise in a live Type journey: a typed HTTP message has 60 seconds, while the bounded planner/verifier sequence can use four 30-second calls before the renderer's own calls. The measured 52.5-second pension planning pass alone leaves little renderer/network margin. Existing lost-approval recovery does not establish recovery of every slow collecting reply. Long meetings can exhaust the retained transcript/reference window and fail closed on old unknown chronology. No all-seven real-provider completion claim is justified yet. Failed runs were kept uncertified and the eval runner refused their engine execution.

## Path to the first 20

1. Close the live semantic completion failures without accepting unsupported inputs or weakening the verifier. Repeat the corpus with production settings and retain all attempts, latency, repairs and failures. A sporadic pass is insufficient to erase a reproducible blocker.
2. On an explicitly approved canary build, run real Speak and Type with synthetic cases for every module. Observe actual provider tools, delivery acknowledgements, execution receipts, matching results and closure. Validate an interrupted read-back cannot execute, a correction requires a fresh confirmation, and repeated approval produces one result.
3. Gerald completes the device checklist below. Confirm failure diagnostics can identify the run, model, versions and failing stage while keeping ordinary logs free of financial content.
4. Only after those gates pass, run a small supervised canary, then decide whether evidence supports the first 20 consumers. Keep Type rollback available and do not infer deployment approval from this audit.

## Gerald's manual check

Use disposable synthetic invitations on the intended build. Record build/version, browser/device, session/lease identity and outcome; never paste a real client transcript into the repo.

1. **Type recovery:** start a cash or mortgage check; refresh with a half-filled card, submit, refresh at confirmation, interrupt the connection after approval, then restore it. Expect the same meeting, corrected card/read-back, one result and no extra approval. Reload results.
2. **Speak delivery:** allow the microphone, then separately deny it. In an active call interrupt the certified read-back, say “yes,” and verify it does not run. Hear the complete current plan, approve once, and verify one matching result and shutdown. Retry approval and refresh.
3. **Meaning:** use the corpus's two similarly named accounts/children and partner pension correction. Ask a question mid-collection; introduce a hypothetical amount; change your mind before confirming. Check owners, figures, exclusions and assumptions in the exact read-back.
4. **Unknowns:** choose “Not sure” for the mortgage rate. It must stop asking and cannot run that mortgage. Refresh, then provide a confident statement rate. Expect a newly verified read-back before execution.
5. **Closure and privacy:** withdraw AI consent during Type and during Speak; reload. Expect both transports stopped and saved results still available. In another session delete while a reply is delayed; no late conversation or result should reappear.
6. **Devices:** repeat on desktop and a real phone in Safari/Chrome with the keyboard open. Check scrolling, focus, every control, audio switching, reconnection and the final result. Complete at least one real-provider journey for each of the seven modules before declaring the first 20 ready.
