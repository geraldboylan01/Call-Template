# Independent review of Claude's real-model evidence

Reviewed commit `825b18af5fbf4d12dbf817db1f2a922e17f9ab5f`, against the saved Astra audit at `cd37a84`. No production files changed and no provider calls made for this review. The executable audit is `scripts/audit-claude-evidence-replay.mjs`; generated synthetic evidence is under `diagnostics/claude-review/evidence-replay/` (ignored local diagnostics).

## Findings that change the diagnosis

**P1: the new material-assumption floor disappears for an already canonical input.** `materialAssumptionsFor` in `worker/src/consumer/direct_module_planner.js` requires `item.authoredInput`. `normalizeDirectSnapshot` deliberately omits that optional field when the authored and canonical inputs are equal. Consequently an aggregate-only liquidity input gets an empty material-assumption list; the equivalent representation with `cashItems` retains `authoredInput` and gets the required three- and six-month reserve assumptions. Four actual verifier requests in the failing r1/r2b liquidity runs have the empty floor; the passing r3b request has the floor. One recorded verifier explicitly complains that the floor is empty. This is introduced deterministic representation sensitivity, not merely model variance. It does not by itself bypass the verifier, which still has full policy and conversation, but it falsifies the claim that the declared floor is always supplied.

**The House Purchase failure is not exclusively a read-back-length decision.** In r1 the final repair supplies all five purchase-cost amounts but drops 37 evidence entries and becomes structurally unsupported. In r2b it repairs the household cash-flow omissions while deleting previously explicit purchase-cost amounts. In r3b it returns an empty confirmation. Increasing the allowed word count does not solve these repair defects; the current extractor already expressly permits a longer complex-household read-back.

**The paid runs do not exercise the claimed production wall-clock ceiling.** The runner calls `interpretDirectModuleConversation` directly without `deadlineAt`. Its saved configuration has a 30,000 ms per-call timeout but no turn budget. The source explicitly preserves unbounded-pass behaviour when `deadlineAt` is null. The 101.8-second House run is therefore possible without testing the production 90-second boundary at all. These are real-model semantic tests, not full Speak/Type production-budget tests.

Using the recorded latencies, the first extractor + structural repair + verifier take approximately 66.3, 65.5, and 53.5 seconds for House r1/r2b/r3b. A 90-second deadline leaves 23.7, 24.5, and 36.5 seconds respectively. The implementation's adaptive semantic-repair floor is twice the slowest previous call: approximately 57.3, 56.2, and 47.2 seconds. Therefore all three semantic repairs would be skipped at those observed timings under the production deadline. This is arithmetic from recorded latencies, not a fresh timed production run.

## What was independently reproduced

The offline audit feeds the 90 archived provider responses through the current interpreter for all 36 cases in `paid-v10c-r1`, `paid-v10c-r2b`, and `paid-v10c-r3b`. It reproduces the exact returned verification objects and call counts. Every extractor, structural repair, semantic repair and verifier receives the complete recorded conversation, byte for byte. This is deterministic replay, not a fresh estimate of model success probability or a simulation of elapsed time.

| Case | r1 | r2b | r3b |
| --- | --- | --- | --- |
| PBS | pass, 4 calls, 44.3 s | pass, 4 calls, 38.2 s | pass, 2 calls, 15.9 s |
| Liquidity | fail, 4 calls, 43.4 s | fail, 4 calls, 46.3 s | pass, 2 calls, 22.6 s |
| Mortgage, ambiguous ownership wording | pass, 4 calls, 40.2 s | fail, 2 calls, 23.5 s | fail, 2 calls, 19.2 s |
| Mortgage, explicit joint ownership | pass, 4 calls, 33.3 s | pass, 2 calls, 15.8 s | pass, 2 calls, 14.5 s |
| Loan | pass, 2 calls, 15.0 s | pass, 2 calls, 17.1 s | pass, 2 calls, 16.0 s |
| College | pass, 2 calls, 16.8 s | fail, 4 calls, 33.6 s | pass, 2 calls, 19.2 s |
| Pension | pass, 3 calls, 40.5 s | pass, 2 calls, 24.2 s | fail, 5 calls, 62.9 s |
| House Purchase | fail, 4 calls, 88.6 s | fail, 5 calls, 101.8 s | fail, 4 calls, 77.0 s |
| PBS collecting; mortgage doubtful; mortgage acknowledged unknown; mortgage unknown recovered | all four pass | all four pass | all four pass |
| Total | 10/12 | 8/12 | 9/12 |

Claude's r1 PBS entry says two calls/17 seconds; the final clean r1 artifact actually records four calls/44.3 seconds. All 90 archived responses identify `gpt-5.6-luna`, low reasoning effort, and default service tier. The case dates use 2026-09-05, and these runs occurred on 2026-09-07. The prompt labels are planner v10 / verifier v7, but prompt source changed more than once under those labels during earlier v10 batches. The archives do not save git commit, prompt hashes, complete request bodies, or deadline/budget. Their exact final returned behaviour is reproducible, but the original requests are reconstructed from code, not independently archived requests.

## Liquidity: a deterministic defect plus verifier false rejections

The r1 first proposal cites only the correction turn for a €33,000 aggregate; that turn alone does not establish the earlier €18,000 and €12,000 cash holdings. Requesting the missing supporting citations is reasonable. The same verifier also demands the numeric values of the *excluded* home and pension, which do not enter this cash-only calculation. That requirement is not consistently applied: the passing r3b confirmation excludes those categories without quoting their values. This is unstable materiality judgement.

The r1 repair restores both original holdings and the later correction, but the second verifier rejects changed precision and notes the absent material-assumption floor. The interpreter retains the first rejected snapshot/verdict, so examining only `result.verification` hides this second diagnosis.

The r2b first proposal supplies a broad exact quote containing the two unchanged holdings and the old joint balance, together with a separate exact quote correcting the joint balance. The verifier treats the presence of the old figure in that context as invalid support. A narrower repair removes the old joint balance from the first quote. The next verifier nevertheless says the quote omits the €18,000 and €12,000 amounts, while its actual request contains:

> My savings is 18 thousand and my wife has 12 thousand. We are counting both.

That particular refusal is factually wrong. It is not explained by dropped server-owned citations or unavailable source text. It also newly demands the job-loss scenario in the confirmation. The passing r3b represents the holdings separately in `cashItems`; it retains a broad old-plus-correction citation too, but the verifier accepts it.

The likely architectural contributors are an overloaded aggregate citation representation, inconsistent treatment of correction context, a materiality judgement that expands between verifier passes, and the new shape-dependent assumption floor. Three samples do not isolate the causal weight of each. Calling the failures either normal variance or a proven prompt regression would overstate the evidence.

## College: a real first error, then a false refusal

In r2b, the first proposal attaches Anna's later age correction to Anne's `/children/1/currentAge`. The verifier correctly rejects that attribution. The repair removes that bad entry and retains the exact c1 quotation `Anna is twelve and Anne is eight.` for Anne's age of eight. The second verifier calls this inaccurate because it wanted `Anne is eight` by itself. The wider quote is a genuine contiguous span, names both children distinctly, and supports Anne's age. The current extractor explicitly allows such wider exact spans. This refusal is inconsistent with that provenance contract; weakening factual verification is unnecessary to correct it.

## Mortgage: retain the ambiguous case, score its safety behaviour separately

The original fixture says `jointly held by me, Aoife, and Ben`, while the profile identifies Aoife and Ben. That can be read as an appositive or as a list of three holders. Two final runs ask the client to resolve it and do not repair through the ambiguity. The separate explicit-joint-ownership case passes all three runs, including the same corrected rate and excluded hypothetical rate. This is evidence that the semantic ambiguity gate is doing useful work, not evidence that rate correction itself regressed.

Do not rewrite the historical fixture or recategorize old results silently. Preserve it as the ambiguity stress case, add an explicitly scored clarification branch with a subsequent unambiguous answer, and keep the already separate clear-ownership completion case. This does not prove every rejected ownership claim is correct: both failed proposals also omit named owners from the confirmation, so that defect and the ambiguous source wording should be distinguished.

## Pension: unstable repair and materiality, not numerical drift

All final runs retain the corrected €125,000 Ben pot and other tested native values. In r3b the first verifier rejects a confirmation that says `full State Pension` without `Irish` and omits the explicit no-other-retirement-income exclusion. The repair restores the Irish pension wording, but the next verifier now demands that it explicitly apply to both people and flags the broad old-pot citation, even though the separate later correction remains present. Both verifier calls have the complete transcript, and fixed server-path filtering removes no pension citations in these clean runs. The meaningful exclusion should survive repair; a new semantic extractor pass replacing the whole proposal does not reliably preserve all previously correct confirmation content.

## House Purchase: all three terminal paths

| Run | After structural repair | Semantic repair outcome |
| --- | --- | --- |
| r1 | Ready with 59 evidence entries; verifier requests costs and suggested-reserve treatment | Repair reads all five cost amounts and suggested reserve, but returns only 22 evidence entries. `/lendingCategory`, `/applicationType`, `/dependants`, and `/otherKnownMonthlyCommitments` lose support. The normalizer downgrades it; there is no fifth verifier call. |
| r2b | Ready with 63 evidence entries and explicit costs, but missing household cash flow and lender/scheme context | Repair adds cash flow but replaces five cost amounts with `the stated purchase costs`; stays structurally ready. Final verifier rejects those omitted amounts and omission of First Home Scheme `not applied` status. |
| r3b | Ready with 44 evidence entries, but confirmation says only `household cash flow` and omits costs | Semantic repair retains the evidence and ready status, but returns an empty confirmation. No fifth verifier call occurs. |

The first House verifier's rejection is what the interpreter returns when a repair fails. Calling all three final failures “clean provenance and only purchase-cost read-back missing” mistakes the retained first proposal for the final repair attempt. The safety boundary holds in these recordings, but the repair mechanism is non-monotonic: it can fix one representation defect while introducing another.

## Controlled citation ablation

The audit loads an in-memory copy of the current planner with exactly the `fixedPolicyPaths` citation-filter predicate removed. It normalizes every recorded extraction twice, with the predicate on and off. This is a free paired comparison using the same model responses; it never edits production code or calls a provider.

The predicate drops 14 notes across 14 proposals, mostly `/repaymentType` and one `/intendedUse`. On/off produces identical native inputs, policy data, readiness, and confirmation; only those evidence annotations change. No final clean liquidity or pension proposal has a note removed by this predicate. The full source conversation is present in every verifier request either way. Thus direct removal of financial evidence by this predicate cannot explain final liquidity flakiness. A possible attention effect from generally changed prompt length or other envelope content remains unmeasured and would require actual paired verifier samples.

## Work to hand back

1. Derive the material-assumption floor from `authoredInput ?? input`, with an explicit regression proving equivalence for aggregate-only versus itemized liquidity inputs. Keep evidence-based source attribution and independent verification.
2. Align the verifier's provenance contract with exact contiguous quote width, supported multi-turn corrections, and record identity versus corrected leaf facts. Include the exact college and liquidity false-refusal requests as fixtures. Do not fix this by deleting an earlier turn or by a regex selecting client numbers.
3. Give repair typed findings and patch scope: read-back defects should not require regeneration of the evidence/input payload; evidence fixes should not replace unrelated confirmation content. AI must still author semantic changes, and any changed proposal must face fresh authoritative verification.
4. Resolve materiality at the appropriate product level: protect material client inputs and choices, and make server-assumption disclosures explicit and applicable. Do not make omitted excluded asset *values* an accidental universal requirement for cash-only analysis.
5. Exercise the real shared planner with the actual absolute deadline, not only the offline direct interpreter. Archive commit, prompt hashes, corpus hash, model/effort, per-call latency, deadline, and candidate/repair outcomes. Keep infrastructure failures separate, as Claude did for contaminated r2/r3.
6. Run paired, interleaved verifier tests on frozen proposals to distinguish prompt/envelope effects from extraction variance; then repeat end-to-end tests on a held-out corpus with a defined latency/completion criterion. Keep the ambiguous mortgage fixture and separately test clarification followed by successful correction.

The recorded evidence supports retaining fail-closed verification and useful structural fixes. It does not support calling the implementation ready for ordinary consumer canary testing. No P0 execution bypass was demonstrated by this evidence-focused sub-audit; code-path and adversarial execution findings belong to the companion safety and budget reviews.
