# Astra handoff — the simplified AI-led loop

11 September 2026. Branch `phase3-codex-round4`. Nothing deployed.

## What you are auditing

**Audit `40deb248a1b5ba578bc4f0de0be83d7f1742dd77`.** That is the last commit that changes behaviour, and every number below was measured against it.

`a60ce36` is the branch tip and adds only this handoff and the evidence files — no code, tests, fixtures or prompts. Checking out the tip is fine; just note that nothing between `40deb248` and it is behaviour to review.

| | |
| --- | --- |
| how the loop works, and what was deleted | [ai-led-simplified-results.md](ai-led-simplified-results.md) — implementation detail, per-file |
| the measured baseline, and how to re-run it | [evidence/ai-led-baseline-2026-09-11/](evidence/ai-led-baseline-2026-09-11/README.md) |

The implementation document was written at `2ae83f0` and **its result tables are superseded** by the evidence directory; it is accurate about the design, not about the current totals. Where they differ, the evidence directory is current.

---

## Verified facts

### What changed since you paused

Three commits, in order.

**`2ae83f0` — one revision instead of a recovery ladder.** The ladder was a structural provenance repair before the audit, then a narrow confirmation *or* evidence patch, then an unconditional full re-author: three author calls, two error classes with separate budgets, a forfeit rule between them. It is now one revision whose form the independent auditor chooses — `presentation` (read-back, citations, or both together, inputs never re-authored) or `reinterpretation` (complete re-author) — with `none` dispatched as written rather than overridden into the widest re-author. Structural provenance defects are reported *to* the audit instead of repaired before it. Author, review, revision, review: four calls, down from seven.

Three defects fixed with it:

- A non-pass verdict blocked certification but did not change what the conversation believed: refused modules kept advertising `ready` with the disputed figures, and Realtime steers on that state. The review now names the modules and paths it cannot resolve, in its own structured clarifications, and those stop being ready — the named path becomes unknown and returns to the list of what is needed. Code applies the AI's answer; it reads no transcript and writes no corrected value.
- A correct recovery to `collecting` was discarded because it was not runnable. The line is now *who decided*: a candidate the planner left collecting is a judgement and replaces what it corrects; a candidate the server downgraded for an unresolvable citation decided nothing and is refused.
- `baseSnapshotRevision` and `throughTurnId` were authored by the model and then checked against what the server already held. Both are now bound from the request and hidden from the model.

**`7ba91a4` — a tool the mode does not offer is unreachable, not just unmentioned.** Direct apply stopped advertising `save_facts`, but the dispatcher validated against every name the live lane defines, so the name alone still routed into the legacy fact writer: spoken-number extraction, owner cues, pension identity, categorical-none presence conflicts and a second approval grammar. One predicate now drives both the advertised list and the dispatch. Nothing in production had asked for it — the model would have had to produce a name it was never shown.

**`40deb248` — the evaluation evidence became reproducible.** Five breaks, found by checking out into an empty worktree rather than reasoning about imports. Most consequential: the benchmark arm defaulted to `git show HEAD`, correct only while the candidate was uncommitted, so a clean run would have loaded the same source into both arms and reported a flawless dead heat. Also: `check:first20` could not run at all (a tracked gate probe read gitignored `diagnostics/`), and the paired comparison silently ran 12 cases instead of 17 when the holdouts were absent.

No production prompt, financial assumption, engine, architecture or rollout setting changed in any of the three, beyond what is described above.

### Baseline results

34 paired case-repetitions, all sharing a byte-identical first request and response; benchmark pinned to `30eab9e`.

| | pass/34 | <45s/34 | ready certified/22 | blocked/12 | max calls | mean | paid calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Option 2 | 28 | 27 | 16 | 12/12 | 6 | 25.3s | 71 |
| Simplified | 29 | 29 | 17 | 12/12 | 4 | 20.5s | 58 |

| seeded probe | Option 2 | Simplified |
| --- | ---: | ---: |
| equal-value stale owners | 1/2 | 2/2 |
| hypothetical rate promoted | 2/2 | 2/2 |
| superseded borrower restored | 2/2 | 1/2 |
| **withdrawn certainty forced ready** | **0/2** | **2/2** |
| total | 5/8 | 7/8 |

**Zero incorrectly certified or executed outcomes in either arm, in either suite, across 84 rows.** Full `check:consumer` exit 0 over 74 targets. `check-first20-verifier-rejection` 3/3 with zero engine runs from the superseded input; the `Ja.` certified-approval regression 20/20.

**The paired margin is noise.** Across four runs of this harness Option 2 has scored 25–28/34 on byte-identical code and the candidate 26–29/34; the sign has flipped three times. What is repeatable is the four-call ceiling, ~18% fewer paid calls, ~19% lower mean time, and the adversarial gap.

Three failures in this run were provider infrastructure, not architecture: `house-joint-cash-ringfence` timed out in **both arms symmetrically** in r2, and one Option 2 seeded row hit `module_planner_unavailable`. House Purchase passed once (candidate, r1) — the first time observed — and we are treating that as one observation, not a fix.

**House is a module-specific problem and we have not tuned the core loop around it.** It has the widest native contract, the largest quote-copying burden and an open input-contract defect of its own; it fails under both arms and failed under every arm of your earlier four-way comparison. We added no House-specific handling and no second semantic coverage ledger, per your own recommendation. It is a canary blocker, not evidence that the recovery architecture is wrong.

### The one-revision limitation, which fails safe

Collapsing the ladder costs a second attempt. When the auditor scopes a proposal `presentation` but its financial content is actually wrong, the revision is spent on wording and there is no second chance. Observed twice: an equal-value owner swap in the seeded probes, and `seed-superseded-borrower-restored` r2 in this baseline, where the auditor asked for `reinterpretation`, the fresh audit then asked for `presentation`, and the budget was already spent.

**It fails closed every time** — `certificate: null`, nothing executes. It is a completeness cost, not a safety one. It is also why the seeded total moved 8/8 → 7/8 against the last reported figure; across three runs that probe set has scored 6/8, 8/8, 7/8, so 8/8 was a favourable sample rather than a level.

### The approval grammar we did not touch

> **SUPERSEDED, 14 September 2026.** Astra's audit found three P1 execution
> bypasses at this boundary and the section below is now a record of the
> architecture that produced them, not of the code. `execution_approval.js`
> no longer decides anything on the direct/apply path: what a client's answer
> meant is read by a bounded AI decision in
> [approval_decision.js](../worker/src/consumer/live/approval_decision.js),
> given the complete reply, the exact assistant utterance it answered, the
> exact delivered certified offer and the turns in between. Deterministic code
> now enforces only control facts, and an execution-time fence blocks a plan
> whose approval the client has already spoken past. The three bypasses are
> committed as regressions in
> [check-live-approval-meaning.mjs](../scripts/check-live-approval-meaning.mjs).
> The grammar survives only in the archived comparison lane, which is not in
> production. **Open question 2 below is answered by that change and open
> question 1's list of barriers is now one barrier longer.** Nothing is
> deployed.


`execution_approval.js` still decides, by NFKC normalisation, four dictionaries and a whole-clause grammar, whether a client's words authorise execution. It is consumed at four points and governs both Speak and Type.

**This is not the target architecture.** It is a deterministic reader of client language sitting in the one place the architecture says AI should own, and it should go. It is still here because it is currently load-bearing, for one specific reason.

At [live_session.js:1552](../worker/src/consumer/live/live_session.js:1552) a recognised approval **skips the direct planner pass entirely** — so it is not really an approval filter, it is the assertion that *this turn added no financial information requiring review*. Its job today is to stop a pure approval turn needlessly reopening an already-delivered, already-certified plan to another stochastic planner and verifier pass. That is the only thing standing between such a plan and a second opinion that can withdraw it. `check-live-certified-approval.mjs` proves it: scenario 1 executes under a reversing verifier only because the classifier matched; scenario 2 sends the non-approval turn *"Do I need to do it?"*, lets the reversal retire the offer, and asserts that as correct.

One correction to our own record: the 2026-09-05 fix was noted as comparing the certificate-*independent* `directModuleCandidateMeaningKey`. In the code both live barriers use `directModulePlanMeaningKey`, which folds in certificate identity, and `realtime_analysis.js:239` additionally requires `latest.brief.readyToConfirm === true`. A verifier reversal therefore still blocks, and the regex is what stands in front of it.

Recognising approval never authorises execution by itself: offer token, `readbackFullyDelivered`, `reviewStatus === 'settled'`, causal turn, frozen certificate and idempotent receipt are all checked independently.

---

## Open questions for you

**1. Is there a remaining P0/P1 route by which a stale, changed or uncertified plan can execute?** We believe not, and the barriers are unchanged from your last review — latest-certificate check, frozen native inputs, exact read-back hash, causal turn binding, plan nonce, profile revision, idempotent receipt. What is new since you looked is the refusal-application rule, which mutates snapshot state on a non-pass verdict. It only ever moves a module *away* from `ready`, runs only when no certificate exists in that pass, and is pinned by a regression asserting a passing verdict is untouched. We would like that reasoning checked rather than accepted.

**2. Is the intended AI-led approval direction sound, without recreating the 2026-09-05 verifier reversal?**

The direction we want to take, and want you to judge:

- **AI decides the meaning of the latest turn** — whether it is pure approval, or carries a correction, a condition, uncertainty, a question, or any other new meaning. That is a semantic judgement and belongs to AI, not to a dictionary.
- **Deterministic code enforces only protocol facts**: that the answer is causally bound to the exact current delivered certified offer, that the certificate is valid and current, that a superseding plan retires the old one, and that execution is idempotent. Nothing in that list requires reading what the client said.

**We are explicitly not proposing a deterministic proof that meaning is unchanged.** Equal native inputs do not provide one, and neither does a certificate-independent meaning key: a client can correct an owner, narrow an exclusion or withdraw certainty without moving a single figure, which is exactly what the equal-value owner-swap probe demonstrates. `direct_module_identity.js` says as much in its own comments, and `check-live-certified-approval.mjs` records that comparing the candidate alone cannot separate a real correction from model variance. Any design that leans on input equality to decide "nothing changed" should be treated as unsound, including if we propose it.

So the open question is genuinely open: if AI owns "is this pure approval", what stops a pure approval turn being re-read by a fresh planner and verifier pass that can disagree with itself and withdraw a plan the client has already approved? We think a measured reversal rate on transcripts that gained only a read-back and an assent is a prerequisite to answering that. Is that the right sequence, and what barrier design holds without either a regex or a second stochastic opinion?

**3. Go / no-go for controlled Type and Speak canaries?** Our reading is **no-go**, on your own criteria: House Purchase remains unavailable, the laboratory has established nothing about real audio, delivery or device behaviour, and the approval work above is outstanding. The candidate is at parity on the corpus and better on the adversarial probes with a lower ceiling, which we read as "ready to keep testing", not "ready to meet a person". We would like that confirmed or overruled, and if overruled, what the narrowest safe canary would be.
