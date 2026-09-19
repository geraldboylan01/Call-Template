# Independent audit of Claude's implementation

8 September 2026. Reviewed `cd37a84..825b18af5fbf4d12dbf817db1f2a922e17f9ab5f` against the preserved first-20 audit. Production code, financial assumptions and engines remain unchanged. Nothing deployed. This review adds audit scripts and evidence; it does not implement the recommendations below.

**Verdict: NOT READY for real consumer Speak/Type canary testing.** Retain the useful changes, but revise Fixes B, C and D before further readiness claims. No new P0 execution bypass was reproduced. Several P1 completion defects and incorrect safety/reliability claims were reproduced.

## Findings and disposition

### P1 — Fix C supplies a representation-dependent and sometimes falsely narrowed floor

At `worker/src/consumer/direct_module_planner.js:1447`, material assumptions require `item.authoredInput`. That field is deliberately omitted at line 900 when authored input already equals canonical input. A ready canonical liquidity proposal therefore receives no three-/six-month assumption floor. An equivalent itemized cash proposal retains `authoredInput` and receives it. Four verifier requests in the failed clean liquidity runs reproduce the missing floor.

There is a second source-attribution defect at line 1461: a conversation citation at a parent record suppresses all recitable assumptions beneath it. An owner/age quote establishes the pension record, but does not establish that the client supplied State Pension inclusion or start age. The new adversarial pension probe removes the explicit State Pension sentence and its leaf evidence, keeps the owner-only record citations, and discloses the four genuine defaults. All four disappear from the verifier's floor despite the module retaining `authoredInput`. This is separate from the canonical-input bug.

**Change:** derive applicable assumptions from an explicit authored view with canonical fallback, preserving which fields were actually defaulted. Separate record-existence evidence from AI-authored, independently verified leaf source attribution. A parent support pointer is not proof that every descendant was supplied by the client. Do not fix this by parsing client language deterministically. The verifier's full conversation and policy remain available, so these defects do not themselves override its rejection.

### P1 — Fix B's full-snapshot repairs lose previously correct content

The per-interpreter maximum is correctly bounded at two repairs/five calls. Explicit unresolved ambiguities prevent semantic repair; structural ambiguity guards also hold in the tested cases. However, “representation-only” and “monotone” are instructions, not enforced properties of the returned replacement.

The actual House repairs falsify preservation claims:

- r1 fixes the cost read-back but cuts evidence from 59 entries to 22. Four client input paths lose support; the candidate is downgraded and there is no second verifier call.
- r2b restores household cash flow while replacing previously explicit cost amounts with “the stated purchase costs.” The fresh verifier rejects it.
- r3b returns an empty confirmation, so no final verifier call occurs.

Our scripted five-call correction probe makes the second repair change a corrected €340,000 mortgage back to €240,000. The final verifier sees the changed input and complete correction history. Its rejection prevents certification and preserves the earlier rejected proposal. An intentionally erroneous scripted final pass can certify the stale repair: this demonstrates reliance on AI semantic verification, not a deterministic bypass of a rejecting verifier.

**Keep** the separate bounded opportunities. **Change** the repair contract: structured findings should select a repair scope; a read-back-only defect should return replacement read-back content, leaving input and evidence structurally untouched. An evidence repair should patch identified citations. Financial semantic changes must remain AI-authored and face fresh verification; do not silently convert them into representation repair. Do not preserve a known-bad citation merely to satisfy an append-only instruction.

### P1 — Fix D does not enforce its advertised deadline or request call graph

`scripts/audit-claude-budget.mjs` reproduces six failures, using real Durable Objects and migrated SQLite for the session cases:

1. **Post-deadline dispatch:** `structuredResponse` at planner line 232 computes a zero budget, schedules `setTimeout(0)`, then calls `fetch` at line 254. Both extraction and verification are dispatched with an already expired deadline and an initially un-aborted signal. Fast scripted responses even produce a certificate. This is a deadline defect, not evidence of uncertified execution.
2. **Type renderer outside the budget:** `handleTextMessageWithinBudget` calls `renderLiveAssistantText` at live-session line 1662 without a deadline. Its separate 20-second timer does not include the shared planning budget. The expired-boundary probe dispatches both the renderer and the detached compliance review after the deadline. Detached supervision may properly have its own lifecycle, but must be explicitly accounted for rather than covered by a claim of zero subsequent provider calls.
3. **Speak captures no deadline:** the drain captures `directModulePlanningDeadlineAt` at line 2357 before awaiting persistence/context. A background Speak pass captures `null`; arming a deadline at later `get_state` cannot update that captured argument. The probe completes extraction after the newly armed boundary and then starts verification. The blocking await itself has no independent deadline race/cancellation.
4. **A second planning chain still starts:** `get_state` at line 3563 reschedules a failed outstanding obligation while time remains. One real typed request reproduces **seven planner/verifier calls, two renderer calls and one detached review**: an extraction plus failed verifier, renderer `get_state`, then a second chain using both repairs. Five is a per-pass limit, not a per-request limit. The drain can also process newer turns; there is no fixed whole-request call-count cap.
5. **Completed usage disappears on a later failure:** the initial extraction succeeds with 110 tokens; the initial verifier times out. `runDirectModulePlanning` only records usage after the interpreter returns (lines 1161–1198), so the usage table has zero rows and the obligation remains outstanding. Successful-path accounting passes; failed-chain accounting does not. This predates Claude's work, but the new deadline creates more relevant failure boundaries and the blanket metering claim is false.
6. **Termination does not cancel the chain:** after explicit real-session `terminalize('complete', 'consumer_closed', ...)`, an already started extraction completes and dispatches a new verifier with an un-aborted signal. This cancellation gap also predates the new deadline. No post-close module execution was demonstrated.

The adaptive repair floor is a latency heuristic, not a proof that the next two calls finish: their latency can exceed every prior sample. For the actual clean House timings, the remaining 90-second budget after the first verifier is about 23.7/24.5/36.5 seconds, below the corresponding 57.3/56.2/47.2-second adaptive floor. All three would skip semantic repair under that budget.

**Change:** one explicit operation identity, absolute deadline, cancellation signal and call allowance must cover every blocking stage and retries. Check deadline/cancellation synchronously immediately before dispatch and after intervening awaits. Background work must have its own bounded lifecycle; waiting on it must not inherit an unbounded promise. Decide explicitly whether failed work resumes in a later operation, rather than implicitly creating another chain through rendering. Meter each completed response durably by its actual provider response ID, even when a later stage fails; account separately for dispatched work whose final usage is unknown. A client abort does not prove that the provider incurred no charge.

### P1 — New Type recovery is not bound to the failed message

At `js/plan/typed_meeting.js:391`, any final assistant turn ends recovery. If a failed POST is still being persisted, a GET may return the *previous* assistant question: recovery then stops before observing the submitted message or its reply. Our controller probe reproduces this. Another probe makes 35 status polls fail; `recoveryAttempts` remains zero because only successful reads increment it. Thus the promised 30-attempt bound does not cover an outage. Successful recovery also leaves the already-submitted text in the retry composer.

`sendTypedMessage` has no durable client message ID, and the server creates a new random `msg_` ID for every submission. Retrying can therefore create a second turn and pay for another planning pass. This is not proof of duplicate financial execution: the existing plan/approval barriers remain distinct.

**Change:** persist a client-generated request identity and recover by its durable client turn and causally bound response. Apply a recovery deadline to both successful and failed polls; retain a visible retry/resume action on exhaustion. Clear the retry draft only when it is still the exact recovered submission. Include cancellation, refresh and overlapping requests in the same operation tests.

## Fix A and provenance: retain, with narrower claims

Fix A's useful behaviour survives the adversarial tests. A non-fixed override of €500 accompanied by incoherent disclosures of zero, €500 or null loses the disclosure and remains unsupported without evidence. Repeating that proposal through structural repair produces no certificate. Coherent approved defaults still work; a silently applied undisclosed native default still throws. Fixed policy enforcement and certificate binding remain in place. Valid conversation or canonical profile evidence can support a genuine client override.

Claude's claim that this is “materially stricter” than the old code is incorrect: the old branch threw on contradictory non-fixed disclosures. It did not certify the divergent value on the disclosure alone. This change improves completion by moving refusal to provenance/verification; it is not a stricter accepted-state set than the previous fatal rejection.

Structural support proves a reference exists, not that its words entail a financial value. Parent evidence covers descendants, and an exact quote can still be semantically wrong. Consequently no honest audit can prove that *every* unsupported meaning is impossible to certify independently of verifier accuracy. What is demonstrated is that dropping a disclosure alone provides no new support, and a fresh rejecting verifier still blocks.

Retain the contiguous-quote guidance and diagnostics, but align the verifier with the same contract. The recorded college repair quotes `Anna is twelve and Anne is eight.` for Anne's age; the verifier wrongly rejects it for not quoting only `Anne is eight`. Repaired liquidity evidence explicitly includes the €18,000 and €12,000 holdings that its verifier claims are absent.

Occurrence counting remains lexical, not numeric interpretation. The audit accepts `50` as an exact unique span inside `250,50`; semantic meaning must still be checked independently. Do not turn this into a financial-number parser. Explicit quote offsets plus surrounding context would make occurrence selection unambiguous without interpreting numbers. Drop diagnostics currently cover only some filters: fixed-path removals, invalid input paths and failed profile references do not all get reasons, and a token-boundary failure can be labelled “not a contiguous substring” even when the substring exists.

The controlled fixed-citation ablation retains identical native input, policy, readiness and confirmation for every archived proposal. It removes 14 notes across 14 proposals; it removes **none** from the final clean liquidity or pension proposals. Every one of the 90 reconstructed requests retains the complete recorded conversation. Therefore those dropped citations cannot directly explain the final liquidity failures. This does not establish that every future long conversation retains all useful context, or rule out model-attention effects from changed prompts.

## House Purchase recommendation

**Choose (c): an explicit confirmation-coverage contract, with longer disclosures where needed. Do not lower the verifier simply to pass House.** Server ownership of assumption policy is the correct boundary. Treating a `recite` boolean plus an open-ended demand for “all material facts” as a complete presentation contract is insufficient.

Purchase-cost allowances reduce funds available for purchase; reserve treatment changes usable cash. Those are consequential assumptions, not mere schema bookkeeping. Under the current approved `recite` policy, keep all five numeric cost allowances in the confirmation, along with rates and term. A grouped cost total with fully disclosed components could be a considered future presentation policy, but silently substituting that now would change the requirement. This audit makes no such change.

For the emergency reserve, distinguish **treatment/method** from **calculated result**. `js/house_purchase/engine.js:365` derives the suggested reserve using the existing six-month target and relevant expenditure, then adds the separate other-goal ringfence before calculating available cash. Explain that reserve treatment and keep the €10,000 other-goal amount distinct. Do not ask the AI to invent the resulting euro reserve before the engine runs. The coverage metadata should express meaningful modes and exclusions as well as scalar numbers; not every mode is inconsequential bookkeeping.

The current prompt already explicitly permits confirmations longer than 60–90 words. Permission to use 150 words is therefore not the missing technical fix. Eight new, interleaved real-model verifier-only calls used the frozen r2b House input and unchanged current verifier prompt/schema:

| Variant | Results |
| --- | --- |
| Original defective read-back, twice | 2/2 refused for missing cost amounts |
| Longer read-back covering costs, cash flow, reserve separation, rates, term and scheme status, twice | 2/2 refused for additional employment/income-stability and, in one run, residency/ownership/site-equity disclosures |
| Same longer wording with numeric cost allowances removed, twice | 2/2 refused |
| Stale €420,000 native price and read-back despite the later €410,000 correction, twice | 2/2 rejected |

The longer draft has 171 whitespace-delimited written words; speaking the currency amounts expands it further. This was a controlled diagnostic, not a complete candidate product design or an end-to-end completion score. Its additional refusals can concern consequential facts; they must not simply be suppressed. The experiment shows that fixing the previously listed omissions does not by itself establish complete confirmation coverage.

Recommended architecture: the AI identifies client facts, owners, precision, choices and exclusions; the server contributes applicable assumption descriptors from versioned policy. Build an explicit structured coverage set. Let the AI and independent verifier determine client semantic sufficiency against the entire conversation, while deterministic code enforces structure, coverage identity and policy inclusion. Generate concise client-fact and assumption sections from that set and verify the exact resulting read-back. Repairs to wording must not re-create inputs or evidence. If presentation is split into spoken sections, bind every section and completed delivery to one immutable plan/certificate; any correction invalidates affected approval and requires fresh verification. The final verifier must retain unconditional rejection authority. A structured confirmation is not permission to omit unsupported or uncomfortable facts.

## Flakiness and evidence quality

The clean aggregate scores are correct: 10/12, 8/12 and 9/12. Claude's r1 PBS entry is not: it is four calls/44.3 seconds, not two calls/17 seconds. The original paid runner never supplies `deadlineAt`, and its archived configuration includes only the per-call timeout, so these were not production-turn-budget runs.

- **Liquidity:** new deterministic floor loss, different aggregate/itemized representations, unstable materiality and demonstrably false verifier objections. Fixed-path citation removal is not the direct cause in these runs.
- **College:** a genuine first wrong-child citation, followed by a false rejection of the repaired wider exact quote.
- **Mortgage:** the original “me, Aoife, and Ben” wording admits competing owner readings. Explicit-two-owner runs pass 3/3. Preserve the ambiguity stress case and add a scored clarification→answer→completion branch; do not silently turn it into a pass or discard it.
- **Pension:** tested financial values, including Ben's corrected pot, survive. Exclusion wording, owner scope of State Pension assumptions and treatment of an old-plus-correction quotation change between passes. This is unresolved confirmation/provenance reliability, not demonstrated numeric drift.
- **House:** loss of evidence, non-preserving read-back repair and empty confirmation, in addition to incomplete material disclosures.

Three samples per case cannot apportion statistical causality among changed prompts and model sampling. Some deterministic causes are proven; some objections are plainly wrong; the remainder should remain unclassified rather than called normal variance. Earlier v10 batches changed prompt text under the same version labels. Future archives must record exact commit, prompt/schema/corpus hashes, requests, operation deadline, per-stage outcomes and latency. The current replay reconstructs requests and reproduces archived verdicts; it is not proof of their original byte identity with requests that were never saved.

## Exact handback to Claude

1. Fix the two assumption-floor/source-attribution defects and add canonical/itemized, parent-only, explicit client-equals-default, profile-evidence and overridden-default cases. Keep financial values unchanged.
2. Replace full-snapshot read-back repair with scoped structured repair, preserving unaffected inputs/evidence by construction. Retain separate bounded repair opportunities and fresh independent verification. Replay all three terminal House failures and the stale second-repair probe.
3. Define the complete House confirmation-coverage contract using the general architecture above. Include client cash flow, ownership, consequential eligibility/exclusion facts, distinct reserve treatment and existing numeric assumptions. Implement presentation without weakening the verifier or imposing an arbitrary word cap.
4. Repair deadline ownership, pre-dispatch checks, cancellation and renderer propagation. Bound background work and retries; prevent the demonstrated hidden second chain if five calls per operation is the intended product guarantee. Include all provider work in documented cost/lifecycle accounting.
5. Persist usage per completed provider response, including aborted chains. Make recovery message-specific and idempotent; test a lost request, lost reply, old GET snapshot, repeated polling errors, retry, cancellation and overlapping requests.
6. Align exact-quote width and correction provenance across extractor and verifier. Preserve history; use explicit citation scope/offsets rather than a deterministic client-finance parser. Improve complete server-only drop diagnostics.
7. Turn the new defect-reproducing probes into desired-behaviour regressions. Keep the old stale-certificate/correction regression unchanged. Re-run targeted real-model cases through the actual shared operation deadline, then interleave frozen-proposal comparisons and held-out incremental conversations. Require completion and latency evidence separately from safe clarification/refusal.
8. After those gates pass, run controlled operator Speak/Type device tests for ASR, actual audio delivery, interruptions, microphone denial, reconnect and lost HTTP replies. The present audit provides no replacement for those tests.

## Validation performed

- Existing targeted gates: internal repair 29; first20 semantic integrity 17; direct planning 27; frontend 22; planner budget 3; original stale-verifier execution regression 3. All passed. The internal-repair script emits a `TimeoutNaNWarning`; its scripted timer evidence should not be mistaken for real elapsed-time proof.
- New integrity probes: 14; budget/lifecycle defect reproductions: 6; recovery defect reproductions: 3. Assertions labelled LIMIT/REPRODUCED intentionally document current deficiencies and must be inverted/refined when fixed.
- Offline replay: 36 clean cases / 90 recorded provider responses, plus fixed-citation ablation. Details: [evidence report](claude-review-variance.md).
- Fresh model evidence: eight synthetic verifier-only calls, all HTTP 200, no module execution. Requests, hashes, response usage and findings saved in `diagnostics/claude-review/house-verifier/`.
- No production edit, deployment, new financial assumption, real client record, or claim of a full fresh 799-check audit. Tracked implementation remained unchanged.

Audit scripts: `scripts/audit-claude-integrity.mjs`, `scripts/audit-claude-budget.mjs`, `scripts/audit-claude-recovery.mjs`, `scripts/audit-claude-evidence-replay.mjs`, and `scripts/audit-claude-house-verifier.mjs`. The House script's default is offline capture; only `--paid` makes provider calls.
