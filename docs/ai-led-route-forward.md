# Planéir: the route forward from the direct-module experiments

11 September 2026. Production source reviewed: `30eab9eb9c0737726c9a392ef1805f347aa3b10f`. **No production code, financial assumption values, verifier requirements or deployment settings changed. Nothing was deployed.** The earlier Option 2 audit is paused; this report answers the higher-level architecture question.

## Recommendation

**Keep the direct AI author → independent AI verifier → certified deterministic execution architecture. Keep Option 2 as the best measured recovery baseline. Do not replace it with unconditional full re-authoring or blind second interpretation: neither won the comparison.**

Simplify in a different place: remove actual deterministic interpretation from the live conversation boundary, reduce the bookkeeping the models must reproduce, and give AI one coherent way to revise its proposal—including withdrawing readiness. Retain targeted revision when the AI judges the financial interpretation correct; permit complete re-interpretation when the AI judges it wrong. Applying an AI-selected patch is structural machinery, not code deciding financial meaning.

The destination I recommend is **one author, one independent reviewer, and one bounded AI-directed revision**, followed by review of the resulting complete state. A revision can replace evidence/read-back while keeping already-approved input bytes, or rebuild the full native proposal. Those are two forms of the same AI-owned decision, not separate structural/semantic/narrow/fallback recovery ladders. This consolidation is a design recommendation supported by the failure analysis, **not a claim that an untested consolidated implementation already beats Option 2**. Keep Option 2 as the comparator until that smaller implementation earns replacement.

## What was actually tested

Two repetitions of twelve existing conversations and five independently authored holdouts: **34 paired case-repetitions**, with the same first model response for every arm. The holdouts cover equal-value account owner swaps, withdrawn certainty, reopened collections, competing unconfirmed corrections, and switching the selected borrower. Expected answers were withheld from every provider request.

All arms used `gpt-5.6-luna`, low reasoning, the current native contracts/policy/provenance normalizer and independent verifier, 30 seconds per call and a shared 90-second operation ceiling. The original arms retained the current adaptive repair-entry floor; simple arms used a hard deadline and at most four calls. This compares practical recovery strategies, not just wording in isolation. Reused common-prefix calls retain their measured latency, so timing is a measured/replayed pipeline estimate, not browser or voice latency.

| Recovery strategy | Correct outcome / 34 | Ready cases certified / 22 | Correct outcome below 45s / 34 | Mean pipeline time | Maximum calls observed |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full representation repair, without narrow branches | 25 | 13 | 24 | 27.0s | 5 |
| **Current Option 2** | **31** | **19** | **28** | **26.1s** | 6 |
| Full reconsideration with conversation, criticism and rejected proposal | 27 | 15 | 25 | 26.3s | 4 |
| Fresh second interpretation, without rejected proposal/criticism | 25 | 13 | 24 | 27.3s | 4 |
| Conversation + criticism, without rejected proposal¹ | 27 | 15 | 27 | 27.9s | 4 |

¹ Separately reported follow-up diagnostic, after observing revision-copying failures in the first comparison. It reused the same initial interpretations/audits and made new recovery calls. It was not silently substituted into the original protocol.

“Correct outcome” includes twelve cases expected to remain unavailable across the two repetitions. Every arm correctly blocked those twelve; do not read 31/34 as 31 successful financial analyses. Option 2's ordinary ready-case completion was 19/22, with 16/22 ready cases completed below 45 seconds. Its two repetition totals were 15/17 and 16/17; the other main arms were 13/17→12/17, 13/17→14/17, and 13/17→12/17 respectively.

The comparison produced **194 new provider requests**, with shared prefixes reused across the 170 arm outcomes. All 34 first responses were paired; no first-response pairing exception occurred. A final inspection found no oracle fields in provider envelopes and no inconsistent certificate decision among the **75 certified arm outcomes**. Those outcomes share responses and are not 75 independent safety trials. Native engines completed for authenticated plans. Real approval, ASR, playback, browser recovery and production scheduling were not exercised by this laboratory.

Two repetitions are too small to establish production reliability or a statistically decisive ranking. Nevertheless, the evidence does not support claiming the simple full-rewrite alternatives work better. Option 2 won both repetitions and the under-45-second measure. Its six-call successes in liquidity and explicit-joint mortgage took 57.5s and 47.6s, showing that eventual certification can still be unusable for the intended interaction.

## The more important result: the first financial readings were already right

**All 34 shared first proposals passed the corpus's input-value/owner/collection checks.** This is not proof that every semantic nuance was right: the oracle does not exhaustively judge precision, intent, exclusions or read-back. Independent review is therefore essential. But it shows that this sample's main recovery burden was not repeated inability to read the core financial facts.

Concrete examples:

- **Mortgage:** the verifier called a wide quote “stale rate evidence”, but the evidence entry addressed the unchanged `/currentBalance`. Correct 4.1% rate citations already addressed the later turns. The older 4.5% happened to occur in the balance quote. Keeping that context was not using the old rate.
- **Liquidity:** correct €33,000 cash combines accounts across turns; correct €38,400 annual spending follows from €3,200 monthly. Verifier criticism sometimes demanded that a single quote establish the aggregate or that the client separately state the annual value. The existing engine already performs annual/monthly conversion. In the criticism-only arm, that demand eventually caused an AI proposal to make annual spending null and treat it as missing.
- **Loan:** the verifier first objected to assistant “your mortgage” versus client “our mortgage”, although the mortgage was excluded from the selected car-loan review. Later repairs attracted different objections. In a seeded borrower-switch probe, a verifier demanded an owner field inside the native loan input even though the native contract has no such field and the correct Ben ownership was in the steering/read-back.
- **Read-back:** one audit demanded an explicit statement that no fixed payment was supplied, despite the shared prompt exempting an unspecified optional payment from mandatory recital.
- **Rethink:** two complete, financially correct mortgage rewrites copied revision 1 from the rejected proposal when the request still required base revision 0. Those were genuine interface failures, not incorrect financial interpretation. The criticism-only variant avoided that particular failure, but introduced a policy mismatch in a pension rewrite and still failed seven cases.
- **A verifier pass can also miss material information:** the r2 fresh pension proposal was certified even though its confirmation omitted both retirement ages, 67 and 66, while including current ages, salaries, pots and contributions. Those retirement timings affect the projection and are present in the native inputs. The existing corpus did not check that spoken omission, so the table records a strict-corpus pass, not proof of adequate informed confirmation. I would reject this read-back under the intended material-input contract. It was already above 45 seconds, so this additional finding does not change the under-45 result.

These are not reasons to bypass a rejecting verifier. They are reasons to make its task coherent and judge its refusals as carefully as its approvals. More attempts can eventually obtain a pass without fixing any financial misunderstanding. That is a poor foundation for further repair layers.

## Adversarial recovery probes

The natural sample mostly got its first interpretation right, so four additional probes injected an identical **structurally valid but semantically wrong** first proposal: hypothetical rate promoted to fact, restored superseded borrower, stale owners with equal balances, and forced readiness after a withdrawn rate. All retained authentic quoted source turns; the real independent verifier had to judge their meaning. These are fault-injection tests, not additional natural-sample observations or latency claims. Synthetic first responses had zero tokens and zero latency.

The first semantic verdict rejected each seeded defect when it completed. Two probes initially failed before a verdict; only those two were rerun, preserving the original failures. No incorrect seeded proposal was certified.

- **Equal-value stale owners:** all four strategies repaired the ownership and obtained a correct fresh certificate. Numbers alone could not have detected the error.
- **Hypothetical 6% rate:** all returned repairs changed the input back to 4.1%. Full repair/Option 2 were then blocked by a new ownership verdict about the original “me, Aoife, and Ben” wording; rethink passed; fresh's final verifier timed out. This does **not** demonstrate that Option 2 cannot change financial meaning. It demonstrates the distinction between correct reconstruction and obtaining a coherent final review.
- **Superseded borrower:** on the clean rerun, full repair/Option 2 corrected Aoife's €18,000/8.5%/four-year/€500 scenario to Ben's €9,000/7%/two-year/zero-overpayment scenario and certified it. Rethink produced the right figures but failed the revision interface; fresh produced the right figures but was refused for the nonexistent native owner-field requirement.
- **Withdrawn certainty—an actionable state defect:** all returned repairs correctly made the rate unknown and the module collecting. Option 2/full repair discarded that correct recovery because adoption requires a ready candidate and passing confirmation. Their returned provisional snapshot therefore kept the old `ready` status and 4.1%. They issued no certificate, so execution stayed blocked. Fresh retained the correct collecting/null state. Rethink retained the correct collecting state with the rate absent rather than null; its one strict-oracle failure was representational, not acceptance of a stale rate.

**Adopting a correct non-executable state and authorizing execution must be separate decisions.** Keeping a failed candidate for diagnostics is sensible. Continuing to expose its disputed figures as the current known state is not. The previous stale-certificate P0 regression was also rerun unchanged: **3/3 passed**, including zero engine executions.

## House Purchase is a system diagnostic

House failed both repetitions under all five strategies. Its initial proposals nevertheless preserved the checked price correction, two applicants, separately owned cash, ringfence, cashflow and unknown lender/scheme facts. The failures included provenance completeness, a structural-repair timeout, omitted read-back costs/ownership/reserve treatment and insufficient remaining budget. In one current-arm attempt, no semantic verifier ran at all.

This is therefore not evidence that House needs a special financial parser, a special exception, or just a longer prompt. It combines the system's widest native contract, a large quote-copying burden, implicit engine/policy assumptions and an open-ended spoken confirmation obligation. A generic full rewrite reproduces that burden. Longer read-backs are already allowed, and earlier long-read-back probes still drew further refusals.

Keep the assumption values and independent review. Specify an informed confirmation **presentation contract** that works for both simple and complex plans: what must be spoken, what can be shown, how assumptions are identified, and what the final approval covers. AI should judge whether the actual presentation communicates the material meaning; code should bind and deliver the exact reviewed artefact. A multi-part confirmation may be necessary for complex plans. Do not introduce a second path-by-path semantic coverage ledger or reduce materiality solely to make House pass.

I would withdraw my earlier recommendation to add a separate confirmation-coverage layer as the next fix. The later experiment with that layer added another claim system for the models to contradict. A shared, clearer presentation contract is different from a second semantic representation that deterministic code tries to reconcile.

## KEEP, SIMPLIFY, DELETE, REPLACE

| Disposition | Work |
| --- | --- |
| **KEEP** | Direct AI-authored native inputs, full relevant conversation/context, independent semantic verifier, central approved policy values, native financial engines, structural validation, certificates, exact read-back delivery, causal approval binding, deadlines/cancellation, billing and durable execution idempotency. |
| **KEEP as the measured baseline** | Option 2's AI-selected targeted revisions. Code applying the AI's specified patch is category A. Do not delete it merely because code constrains what changes. Keep complete AI re-authoring available when the interpretation itself is wrong. |
| **SIMPLIFY** | One current proposal and latest critique; one operation; one bounded recovery decision. Consolidate presentation/provenance repair so a finding involving both is not forced through separate branches. Separate non-executable state acceptance from confirmation approval. Server supplies its own revision/version/catalogue metadata; AI need not reproduce it. |
| **SIMPLIFY, validate before replacement** | Provenance should let the AI select authentic source references and let the server supply source text. The independent AI judges entailment, chronology and ownership in full context. Remove pressure to manufacture a unique tiny quote for each copied/derived field. Preserve source integrity and the verifier's refusal power. This interface change was diagnosed, not performance-tested here. |
| **DELETE / replace with AI** | Free-language approval grammar and the semantic-review bypass; active financial question dictionaries; blanket suppression of AI questions based on paths that can represent client choices; invented selection attribution when an AI field is missing; any use of input equality as proof of unchanged conversational meaning. |
| **DELETE misleading guarantees** | “Representation-only” as proof that a full rewrite preserves meaning; “twice the slowest prior call” as a guarantee future work finishes; an old verdict overriding a fresh one; treating `repairScope: none` as `input`; treating a non-ready recovery as unusable state. |
| **REPLACE tests of implementation with tests of outcomes** | Phrase allowlists, zero-model-call approval, hidden-path coverage and mandatory preservation of an old provisional proposal. Preserve fresh rejection, causal binding, ownership, uncertainty, no invented facts, exact certified execution and zero duplicate runs. |

The active streaming compliance detector is a **category C product decision**: some of its financial-language regex are semantic, but removing a low-latency tripwire without deciding how AI supervises speech would be an untested behaviour change. The prohibitions themselves stay. Similarly, pension timing/bridge defaults and disclosure materiality need explicit treatment as approved assumptions or AI-selected choices. No value changes are proposed here.

The complete active-path A/B/C inventory and exact tests are in [ai-led-direct-boundaries.md](ai-led-direct-boundaries.md) and [ai-led-live-execution.md](ai-led-live-execution.md). The unused legacy paths need no rewrite; reject unexpected legacy tools at the direct-mode dispatcher.

## The smallest AI-led loop to aim for

1. **AI interprets the current conversation.** It owns goals, modules, owners, corrections, uncertainty, hypotheticals, collection completeness, clarification and complete native inputs. An existing offer is context, not evidence that newer words preserve its meaning.
2. **Code validates structure and binds sources/policy.** It reports mechanical faults; it does not translate them into claims that the client withheld an answer.
3. **Independent AI reviews the full meaning and proposed response.** It can approve a collecting/clarification state without granting execution, approve a complete plan/read-back, request revision, or say information only the client can supply is needed.
4. **One bounded AI-directed revision when useful.** Correct inputs can be retained while AI repairs evidence/presentation; incorrect meaning triggers a complete AI reconstruction. The reviewer, not a deterministic taxonomy of financial phrases, makes that choice. The complete result faces fresh independent review. No voting, repeated verifier sampling until a pass, or carryover approval.
5. **Code executes only an exactly certified, delivered, explicitly approved current plan.** AI interprets conversational approval/correction; code checks the answer's causal turn, offer ID, current certificate and idempotent receipt. An explicit UI action can express approval directly. Any rejection or uncertainty keeps execution blocked and supersedes stale provisional knowledge.

A four-call author/reviewer/revision/reviewer ceiling is the simplest target; a structural failure caught before the first review need not consume an extra semantic-review stage. The experiment does not yet establish that this consolidated two-form revision reaches Option 2's 31/34 and 28/34-under-45s. That is its replacement threshold, alongside the adversarial safety/state tests—not a promise to ship it on architectural preference.

## Exact next work

Do not start another broad implementation pass. First settle the three mixed boundaries: informed confirmation presentation, consequential engine/default choices, and streaming speech-policy supervision. Then give Claude a narrow design/experiment brief:

1. Replace the current all-or-nothing adoption contract with explicit non-executable-state acceptance versus execution certification; preserve the seeded withdrawn-rate regression.
2. Design the smaller author/reviewer envelope: server-owned metadata supplied once, complete AI-native inputs, authentic source references, AI-authored clarification, and a reviewed presentation. No semantic compiler or second coverage language.
3. Compare one AI-directed revision with Option 2 on the frozen paired corpus and seeded failures. Permit full semantic reconstruction, and permit evidence/read-back revision together. Use the latest critique; remove the unconditional second fallback from the candidate experiment. Do not assume the consolidated variant wins.
4. Replace live approval/question-language rules only within the active direct path; preserve exact offer/source/certificate controls and test real conversational corrections, conditions and ambiguity.
5. Keep the current deterministic engines and run real Speak/Type transport canaries only after semantic/state correctness and the latency gate pass. Finish protocol defects—message-ID recovery, whole-operation idempotency and unusable-response metering—as structural work.

**Current readiness: hold real consumer canaries.** Option 2 is the best tested baseline, but House remains unavailable, slow recoveries exceed the practical limit, provisional unknown recovery is wrong, and the laboratory has not established real audio/delivery/device behaviour. The route forward is to simplify and clarify the existing AI-led boundary, not to start again or add another deterministic reader of financial language.

## Evidence map

- [Protocol and limits](ai-led-comparison-protocol.md).
- [Main paired results](../diagnostics/ai-led-comparison-main-v1/analysis.json); [criticism-only results](../diagnostics/ai-led-criticism-only-v1/analysis.json).
- [Integrity/oracle inspection](../diagnostics/ai-led-comparison-main-v1/final-integrity-check.json).
- [Independent manual review](ai-led-comparison-independent-review.md), initially saved after repetition one; the main/follow-up final totals above supersede its interim totals.
- [Seeded proposal manifests](../scripts/ai-led-seeded-proposals.mjs); results in `diagnostics/ai-led-seeded-results-v1`, with failed first attempts retained in r1 and the two targeted retries in r2.
- Historical raw results: v11 baseline 30/36 (29 below 45s); v14/v15 narrow 34/48 (34 below 45s); v16 Option 2 29/36 (28 below 45s). These were different historical runs, not the controlled paired comparison. Their variation does not by itself establish causality.

The repository's architecture history documents why numeric parsing/region counting, value-only agreement and added semantic coverage previously proved inadequate. That history informs the design; it is not used as authority to preserve an implementation that fails the current architecture boundary or the current experiment.
