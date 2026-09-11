# The simplified AI-led loop: implementation and measured comparison

11 September 2026. Benchmark source `30eab9e` (Option 2, read from git). Candidate source is the working tree. **Nothing was deployed.** No financial assumption values, independent-verifier requirements, deterministic engines, authentication or rollout settings were changed.

## What the loop is now

One proposal, one independent audit, at most one revision in the form that audit chose, and the fresh audit that must approve it. A fixed ceiling of four calls, down from seven.

The auditor declares `revisionScope`:

- **`presentation`** — the proposed values, owners, exclusions and certainty are correct; the read-back, the citations, or both need replacing. The inputs are never re-authored, so this form cannot move a figure. It replaces read-back and citations **together**; they used to be two mutually exclusive branches, so a finding involving both could only be sent down one and the other half stayed broken.
- **`reinterpretation`** — the financial content is itself wrong. A complete re-author with no preservation claim, facing a fresh independent audit. Not a fallback after a narrow attempt fails: the auditor chooses one, once, and the operation affords one.
- **`none`** — only the client can help. Dispatched as written. It used to be overridden into the widest re-author, which spent two calls re-deriving the verdict that had already said so.

Structural provenance failures are no longer repaired **before** the audit. They are reported **to** it as `structuralDiagnostics`, so one judgement covers both sides of what was always one proposal — and the auditor can say a figure should not be there at all instead of the planner perfecting a quote for it. Deterministic validation is unchanged and still runs first: schema version, approved module ids, duplicate ids, JSON shape, native contract satisfaction, policy bounds and citation integrity remain hard gates, and a mechanically invalid proposal never reaches a semantic reviewer. Only provenance *support* is soft, as before.

### Honouring a refusal

A non-pass verdict already blocked certification, so nothing could execute. What it did not do was change what the conversation *believes*: the modules the auditor had just refused went on advertising `ready`, carrying the very figures it disputed, and Realtime steers on that state.

When the latest independent review is not a pass, the modules and paths **it names in its own clarifications** stop being ready: the named path becomes unknown, its citation is dropped, and it returns to the list of what is still needed. A refusal that names no module retires readiness across the plan, because the plan is what was refused. A requirement the client has already said they cannot answer is not reopened.

The AI decides *what* is unresolved; code only applies that answer. Nothing here reads a transcript, weighs a correction, chooses a figure, or infers anything from a value — and the corrected figure is never written either, because reading the correction is the planner's job. This runs only when the verdict is not a pass, so there is no certificate in the pass for it to invalidate; it only ever moves a module **away** from ready; and every certificate, delivery, causal-approval and idempotency barrier is untouched.

### Accepting a state versus certifying one

The old gate adopted a revision only when it came back ready **and** passing, which quietly left the rejected proposal as the client's current known state, disputed figures included. The line is now **who decided**, not whether it can run:

- A candidate the **planner** left collecting is a semantic judgement and replaces what it corrects, runnable or not.
- A candidate the **server** downgraded — a citation that would not resolve — decided nothing. It is a revision that failed mechanically, the proposal it would replace was better supported, and it is refused.

Neither branch can authorise execution. The certificate is still gated on a clean pass over ready modules.

### Server-owned bookkeeping

`baseSnapshotRevision` and `throughTurnId` are no longer authored by the model; they are bound from the request, and stripped from what the model is shown. They were never semantic claims, and requiring them back created a way to lose correct work: a re-author handed the rejected proposal copied that proposal's revision in place of the request's base revision. Both prompt versions are bumped (`direct-module-planner-v13`, `direct-module-verifier-v12`), so certificates issued under the old contract fail closed.

## Frozen paired corpus

Twelve existing scenarios plus five independent holdouts, two repetitions, arm order reversed in repetition two: **34 paired case-repetitions**. `gpt-5.6-luna`, low reasoning, 30s per call, 90s shared operation deadline. Expected answers were withheld from every provider request. **All 34 pairs share a byte-identical first request and the same first response.**

| | correct /34 | correct <45s /34 | ready certified /22 | ready <45s /22 | blocked correct /12 | max calls | mean pipeline | paid calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Option 2 | **28** | **28** | **16** | **16** | 12 | 6 | 24.0s | 60 |
| Simplified | 27 | 27 | 15 | 15 | 12 | **4** | **22.4s** | **50** |

Per repetition: Option 2 15/17 then 13/17; simplified 14/17 then 13/17. Only **3 of 34 pairs diverged** at all — simplified won one, Option 2 won two.

**Certified-but-incorrect outcomes: 0 in both arms.**

Twelve of the 34 are expected to remain unavailable; blocking them is correct but is not a financial analysis, so 27/34 must not be read as 27 plans produced. Both arms blocked all twelve correctly.

### This is parity, and the margin is noise

Option 2 is one case ahead here. In the previous run of this same harness it was one case behind (25 to simplified's 26), and in the run before that, two behind (28 to 29). Option 2's code was byte-identical in all three — it is read from git — and it scored **28, 25, 28**. Simplified scored **29, 26, 27**. Run-to-run variance of ±3 across 34 observations swamps any 1–2 case difference, in either direction.

The honest reading: on the frozen corpus the two are **indistinguishable**. What is repeatable is the rest — a four-call ceiling instead of six, fewer paid calls, slightly lower mean latency, and the adversarial result below.

**The pre-stated absolute threshold is not a usable test and was not met by either arm.** The plan set ≥31/34 and ≥28/34 under 45s, taken from the frozen study's Option 2 figures; Option 2 has not reached 31/34 in any run of this harness. The within-run paired comparison is the meaningful test.

Of the two cases simplified lost: one was a **provider timeout** on its verifier call (`module_planner_timeout`, infrastructure variance — Option 2 had a cached response for that prefix); the other was the auditor choosing `presentation` twice for a proposal whose rate was wrong, which is the known scope-selection limitation below.

House Purchase failed in both arms in both repetitions, as expected. It was not patched and no semantic coverage ledger was added.

## Adversarial seeded probes

Four structurally valid but semantically wrong first proposals, injected identically into both arms, with authentic quoted source turns; the real independent verifier judges the meaning. Two repetitions, 8 rows per arm. Fault injection, not natural-sample observations and not latency claims.

| seed | Option 2 | Simplified |
| --- | ---: | ---: |
| equal-value stale owners | 2/2 | 2/2 |
| hypothetical rate promoted | 1/2 | 2/2 |
| superseded borrower restored | 2/2 | 2/2 |
| **withdrawn certainty forced ready** | **0/2** | **2/2** |
| total | 5/8 | **8/8** |

**No incorrect seeded proposal was certified in either arm.**

The withdrawn-rate probe is the state-acceptance fix, measured: the client retracts certainty about a 4.1% rate, the revision correctly moves the module to collecting with the rate unknown, and that recovery is now adopted instead of discarded. Option 2 kept 4.1% as current state in both repetitions. Execution was blocked in every case either way — but Realtime steers on this state, and it was steering on a retracted number.

### One defect the probes found, and what fixed it

In the first seeded run the auditor scoped an **equal-value owner swap** as `presentation` — no figure had to move, so the emphatic tiebreaker in the contract did not catch it — and the one revision was spent on wording while the ownership stayed wrong. The verifier contract now says explicitly that an owner, entity, exclusion, selected module or stated certainty changing counts as wrong content **even when every figure stays the same**. Simplified went from 6/8 to 8/8. This is contract width, not a new deterministic rule, and it is the failure mode to watch: with one revision, a mis-scoped choice has no second chance.

## Offline gate

The full `check:consumer` chain passes, 73/73 targets. Specifically preserved:

- `check-first20-verifier-rejection.mjs` **3/3, unchanged in strength** — fresh rejection retires the delivered offer, the lowest executor rejects the old certificate, zero engine executions. Its one setup assertion changed: the brief used to keep the extractor's stale 240,000 after the client had corrected it to 340,000 and the review had refused it; that figure is now unknown and re-asked. The corrected 340,000 is not written by the server.
- `check-live-certified-approval.mjs` — the 2026-09-05 `Ja.` production regression, both scenarios.
- Delivery and causal binding, unknown-action chronology, tamper rejection, native maths, budget/cancel, billing and execution idempotency.

Re-scoped to the new loop, keeping their outcomes:

- `check-first20-repair-preservation.mjs` → 18 checks, including three new ones for the refusal rule: a refused plan stops advertising the refused meaning and still certifies nothing; an unnamed refusal retires readiness without erasing a figure nobody disputed; **a passing verdict is untouched**. Every "cannot drop a figure, owner or citation" property and every fresh-rejection-blocks-execution outcome kept; pinned call counts 3/4/6 → 2/3/4; **new**: a reinterpretation that withdraws a value to unknown is adopted as state and certifies nothing.
- `check-live-internal-repair.mjs` → 29 checks. `repair fixes representation, never meaning` is narrowed to the presentation form; a reinterpretation may correct the planner's own mistaken reading. The prohibition on inventing an answer to genuine uncertainty is unchanged.
- `check-first20-planner-budget.mjs` — allowance 7 → 4.

`check-no-stale-exports.mjs` fails on `scripts/ai-led-seeded-proposals.mjs:buildAiLedSeededProposals`, an untracked audit script. Confirmed pre-existing and unrelated: with that file moved aside the check passes.

## What was not done

Per the brief, the free-language approval grammar in `execution_approval.js` and the `confirmsPublishedDirectSnapshot` bypass at [live_session.js:1550](../worker/src/consumer/live/live_session.js:1550) are **untouched**, along with `question_guard.js` and the `compliance.js` streaming detector. Measuring the verifier-reversal rate, and designing an AI-led replacement that does not reproduce the 2026-09-05 stall, is a separate item. The provenance interface change — AI selects source references, the server materialises source text — is also deferred; the route-forward report flags it as diagnosed but not performance-tested.

## Open findings

1. **One revision means one chance at the scope.** When the auditor scopes a proposal as `presentation` but its financial content is actually wrong, the revision is spent on wording and there is no second attempt. Two observed instances: an equal-value owner swap in the seeded probes (fixed by widening the contract — an owner, entity, exclusion or certainty changing is wrong content even when every figure stays the same) and one corpus case where the rate was wrong and `presentation` was chosen twice. This is the structural cost of collapsing the ladder, and it is the thing to watch in any further run.
2. **Clearing a refused path depends on the verifier naming it.** The rule applies `clarifications[].relatedModuleIds` and `relatedPaths`. A verdict that refuses a plan while naming no path retires readiness but erases nothing — deliberately, since erasing an undisputed figure would be worse — so a refusal with vague clarifications leaves a disputed value visible while the module is non-executable.
3. **Sample size.** Two repetitions cannot establish a production reliability figure or a decisive ranking. Across three runs the same Option 2 code scored 28, 25 and 28 of 34.
4. **Approval path untouched.** See above: the verifier-reversal measurement and the AI-led approval decision remain outstanding.

## Readiness

Unchanged: **hold real consumer canaries.** House remains unavailable, real audio, delivery and device behaviour are still unmeasured by this laboratory, and the approval-path work above is outstanding.

## Artifacts

- Harness: `scripts/compare-ai-led-simplified.mjs`, `scripts/run-ai-led-simplified.mjs`, `scripts/summarize-ai-led-simplified.mjs`.
- Seeded: `scripts/compare-ai-led-simplified-seeded.mjs`, `scripts/run-ai-led-simplified-seeded.mjs`.
- Results: `diagnostics/ai-led-simplified-v1/analysis.json`, `diagnostics/ai-led-simplified-seeded-v1/`.

An earlier version of the harness keyed its prefix cache without the output schema so one first proposal could serve both arms. In the reversed repetition the simplified arm ran first and cached a narrow-shaped response that Option 2's normalizer rejected outright, failing all seventeen of its cases with `module_snapshot_watermark_mismatch`. That run was discarded. The harness now sends the first extractor call under the benchmark's wider schema in **both** arms, so the first request is byte-identical and the comparison is symmetric under arm-order reversal.
