# Live lane conversation recovery plan

**Status:** Phases 1 and 2 implemented and retained. Phase 3 was authorised and
attempted, then **removed** — see the history below. Phase 4 and 5 remain
unimplemented. This plan preserves native Realtime turn-taking and the existing
trailing planner/reconciliation architecture.

## Instruction history

The "stop for review before Phase 3" wording that stood here was superseded and
is recorded rather than deleted, because a stale instruction that looks live is
worse than none.

- **Phases 1–2 approved**, with an explicit stop before Phase 3.
- **The stop was lifted.** Phase 3 was authorised directly, along with a
  Finding-3 client fix, with the instruction to continue rather than return for
  another planning round.
- **Phase 3 was implemented and then removed.** Review found the deterministic
  rule backing it admitted invented magnitudes: for the quote "two and a half
  thousand", the reviewer could write 2,000, 25,000, 250,000 or 2,500,000. The
  same change also let a reviewed turn bypass completion-none evidence, so a
  bare "Yes." could empty a collection. Both were removed rather than patched.
- **Remediation retained all Phase 1–2 protocol work** and fixed four defects
  found alongside: reconciliation scheduled before its continuation chain
  settled, typed input not invalidating a pending continuation, an
  un-invalidatable opening race, and a currency default that overwrote a
  client's stated currency.

Phase 3 is **not** approved for re-implementation on the old design. The
corrected design is a separate document.

### What the removed attempt proved

Worth keeping, because it constrains the next design:

- The prompt needs an explicit EUR jurisdiction default. Speech never carries a
  currency word, so a transcription grant without it sends every recovered
  figure to `request_clarification` instead.
- Facts only reach the reviewer when a routed analysis is waiting on one. A
  context without goal/module routing yields no fact contracts, and the
  reviewer correctly writes nothing.
- A prefix rule is not a bound. "Same leading digits and larger" spans four
  orders of magnitude, and a suite that tests only a non-prefix-sharing
  counterexample (4,100) stays green while that hole is open.

## Architectural decision

Semantic interpretation is already first: the Realtime model hears the client
and proposes structured facts through `save_facts`. The immediate defects are
downstream protocol discontinuity and deterministic evidence readers overruling
or failing to review valid semantic proposals. Do not add a synchronous turn
coordinator and do not set `create_response: false` for ordinary live turns.

The target ownership split remains:

- Realtime owns low-latency conversation and first-pass semantic proposals.
- Reconciliation owns trailing semantic review, recovery, ambiguity and
  correction.
- Deterministic code owns schemas, ownership, units, conflicts, permissions,
  confirmation barriers and financial calculations.

## Phase 1 — make the lane able to hold a conversation

1. After every `function_call_output` and refreshed volatile-state injection,
   create a continuation response once the function-calling response is done
   and every output it emitted has been delivered. Do not use `assistantDone`
   as the sole predicate: a response may emit audio before its function call and
   still require a continuation.
2. Bound continuations per root client turn. The final allowed continuation is
   speech-only so a tool loop cannot run forever. Barge-in invalidates a pending
   continuation safely.
3. Attribute Worker-created continuation responses to the original root client
   item and inherit that turn's preceding assistant proposition. They must not
   consume a later VAD turn waiting in the ordinary response queue.
4. Create one opening response after the sideband connects, with an explicit
   empty-conversation branch in ORIENT. The opening must not pretend that a
   client detail already exists.
5. Drive the orb primarily from Realtime output-audio-buffer lifecycle events:
   `speech_stopped`/`response.created` establish `thinking`,
   `output_audio_buffer.started` establishes `assistant_speaking`, and
   `output_audio_buffer.stopped` returns to `listening` once the response is
   complete. `response.done` is a no-audio/failure fallback, not evidence that
   browser playout has finished. Remote audio energy remains visual amplitude
   input, not a phase verdict.

### Phase 1 acceptance

- A scripted meeting completes three consecutive `save_facts` calls without a
  client utterance between them.
- A silent microphone receives an audible opening greeting; this is a required
  paid infrastructure proof, not an optional observation.
- Orb transitions are asserted against output-buffer playback events rather
  than response generation events.
- A dedicated three-continuation causality test asserts, for every link:
  - the response context retains the original causal client item id;
  - the original preceding assistant proposition is inherited;
  - reconciliation is scheduled for the original stored client turn and not a
    later queued VAD turn.

## Phase 2 — make the harness obey the production protocol

Once a simulated response has emitted a function call, the provider must refuse
further `speak()` calls in that response. It may expose the function output to
the scripted model and allow speech only after the Worker sends a new
`response.create`, at which point a distinct response begins. The simulator
must echo Worker response metadata so causal-attribution tests exercise the same
contract as production.

### Phase 2 acceptance

- Existing fluent scenarios fail under the protocol-faithful provider without
  Phase 1 and pass with Phase 1.
- Opening and continuation responses are distinct provider responses.
- Tool-result delivery alone never implies that the model may continue speaking.

## Phase 3 — turn on semantic recovery (ATTEMPTED, REMOVED — superseded)

> The section below is the design that was implemented and removed. It is kept
> for its reasoning, not as an instruction. Do not re-implement it as written:
> the numeric grant it describes has no bound, and the completion-none grant it
> describes fails open.

The numeric transcription grant is scoped to the **finalized client turn under
review**, not to a rejection obligation. Obligations decide what must be
reviewed; they do not decide what language within that reviewed turn may be
transcribed.

Within a reviewed turn, reconciliation may render number words into canonical
digits. The existing narrowest-span rule in the reconciliation prompt remains
unchanged and continues to prohibit a wider ambiguous quote when a narrower
supporting span exists. Arithmetic, totals, differences, percentages-of,
midpoints and currency conversion remain prohibited.

Where a `live_numeric_fact_unsupported` obligation exists, retain agreement
between the original Realtime candidate and the reconciler's numeric leaves as
an additional control. That agreement is not the only door into canonical
state: a fact omitted by Realtime must still be recoverable from the reviewed
turn.

Make every T1 rejection a first-class review obligation carrying its raw span,
without requiring a deterministic value parser to recognize the rejected
language before review is scheduled.

### Required Phase 3 inversion test

Against the same cited span, `two and a half thousand`:

- a proposal of `2500` must be accepted;
- a proposal of `2` must be refused.

Both directions are required. The second proposal is currently authorized by
the unfiltered deterministic numeric scan, so an acceptance-only test would
leave the dangerous inversion intact.

Other positive cases include `two and a half grand`, `a hundred and eighty
grand`, and `about a hundred and eighty k`. Negative cases include `about three
or four` (clarification), `two thousand plus the other three` (no invented
total), and a figure absent from the reviewed turn (refused).

## Phase 4 — demote T1 evidence gates (planned, not approved for code)

Numeric mismatches become reviewable, ungrounded drafts protected by the
existing `plannerReconciliationPreflight` confirmation barrier. Completion and
confirmed-none semantic grants are likewise scoped to completion operations on
the **reviewed client turn**, paired with the assistant proposition being
answered, rather than only to obligation-backed operations. Obligations remain
review scheduling/audit records, not semantic permissions.

## Phase 5 — retire production English grammar (planned, not approved for code)

Move language examples from confirmed-none, pension identity, owner-cue and
affirmation heuristics into replay acceptance tests one rule at a time. Retain
only structural invariants in production and run persona replay after each
removal.

## Numeric evidence caller audit (`financial` versus unfiltered)

No flag or caller changes are part of Phases 1 and 2.

`extractNumericOccurrences()` is the shared raw parse and returns financial and
non-financial occurrences. `extractValueEvidence()` filters that parse to
`occurrence.financial === true`. The split is intentional for ordinary dates,
ages and counts, but a malformed word-number can therefore disappear from the
coverage inventory while remaining authoritative in the unfiltered grounding
path.

Executed examples on the current tree:

| transcript | unfiltered occurrence | financial inventory |
|---|---:|---:|
| `two and a half thousand` | `2` (`financial: false`) | empty |
| `a hundred and eighty grand` | `180` (`financial: false`) | empty |
| `900 a month` | `900` (`financial: false`) | empty |
| `In 2026 I am 42 and have two children aged 8 and 11` | all five numbers | empty |

Production callers of the filtered side are:

- `valueEvidenceCoverage()` and its callers in live reconciliation scheduling,
  planner reconciliation requests, legacy Realtime repair, agent repair and
  planning-turn provenance. These use the filtered set as the capture/review
  denominator, so malformed financial speech can create no coverage gap and no
  review trigger.
- `groundPlannerExtraction()`, which uses the filtered set to decide which
  candidate leaves are financial and to perform one-to-one financial coverage;
  it falls back to the unfiltered scan for leaves classified as uninventoried.
  That fallback inherits any bad normalization from the raw parser.
- Live provenance binding in `live_tools.js`, which can bind only occurrences
  that survive the filtered inventory even though the live fact guard also has
  its own unfiltered number scan.
- Turn segmentation in `turn_segments.js`, where the filtered set affects
  density and whether a split fragment is considered meaningful. Word-number
  misses can therefore also hide density from segmentation.
- Currency validation in reconciliation, where filtered money occurrences are
  primary and the unfiltered scan supplies an EUR-only fallback for small
  unadorned amounts.

The unfiltered reconciliation callers are `groundedNumbers()` in
`reconciliation.js` and its numeric-leaf, relationship-identity and fallback
currency checks. This is the inversion boundary: today the filtered side says
there is no reviewable value in `two and a half thousand`, while the unfiltered
side says the client grounded `2`. Phase 3 must replace parser authority for a
reviewed turn rather than merely widen the obligation trigger.

## Known hard cases retained

- Same-turn repair may trail an immediate redundant question; steering can
  reduce but not eliminate this without synchronously blocking speech.
- Genuine ambiguity correctly costs a clarification turn.
- ASR mishearing remains upstream of this architecture.
- Future ungrounded drafts may be visibly noisy before reconciliation; that is
  an explicit UX decision for Phase 4.
- Additional review obligations may increase reconciliation spend; per-
  occurrence review budgets must be re-measured before Phase 3 ships.

