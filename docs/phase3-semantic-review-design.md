# Phase 3, corrected — semantic review of a finalized client turn

**Status:** revision 4 — IMPLEMENTED, shipping disabled by default.
The mechanism below is built and tested. `CONSUMER_TURN_READING_MODE` gates it
and defaults to `off`, so production behaviour is unchanged until someone turns
it on. The measurement that must precede `apply` is at the end, unskipped.
**Supersedes:** the Phase 3 section of `live-lane-conversation-recovery-plan.md`
(implemented and removed), and revision 1 of this document.

## Why the first implementation failed

It kept the deterministic parser in the loop as a *bound* on the reviewer. The
parser reads "two and a half thousand" as 2, so the rule became "the reviewer
may extend that reading upward if the leading digits match". A prefix is not a
bound: 2,000, 25,000, 250,000 and 2,500,000 all satisfy it.

The lesson is not "pick a tighter arithmetic rule". It is that **a broken
reading cannot anchor a correct one.** Any design deriving its guard from
`extractNumericOccurrences()` inherits that parser's defects.

## Why revision 1 of this document also failed review

Three claims in it were wrong, and each was demonstrated against real code.
They are recorded because each one is a trap the next attempt could fall into.

**Numeric-region counting is not reliable.** Revision 1 proposed a mandatory
"exactly one numeric region in the cited span" gate, on the theory that
*counting* regions stays sound even when *reading* them is wrong. Executed:

```
0 regions  "a couple of grand"              → a valid single figure, REFUSED
1 region   "between three and four thousand" → a genuine range, ACCEPTED
2 regions  "one thousand 500"                → a valid single figure, REFUSED
```

It is wrong in both directions, and it recreates parser authority under a new
name. Dropped as a gate.

**Plausibility is a warning, not evidence of meaning.** Revision 1 leaned on
per-fact ranges as a primary guard. A range cannot separate a wrong €2,000 from
a correct €2,500 — the failure that actually matters. It catches only
order-of-magnitude nonsense. Demoted, and never to be described as validating a
reading.

**The two readers were not independent.** The reconciler already receives
Realtime's proposals through `voiceWriteOutcomes`
(`planner_reconciliation.js:1159`), so "the reviewer and Realtime agree" is
partly the reviewer agreeing with something it was shown. Revision 1's fallback
— a context-free re-read of the bare span — is worse: "hers is ninety" read in
isolation is 90, losing the "grand" scale it inherits from earlier in the turn.

## What this leaves

Honestly: fewer hard guarantees than revision 1 claimed. The load-bearing
protection is one property, and it has to be built deliberately rather than
assumed.

### The one real guard — two readings that cannot see each other's answer

A number reaches canonical state only when two readings agree, where *neither
reading was shown the other's answer*. Independence is about the **answer**,
not the context: both readings need the whole turn and the assistant question,
because that is what makes "hers is ninety" mean ninety thousand.

**The second reading has to be its own pass.** "Withhold `voiceWriteOutcomes`
and compare" was considered and does not work, for two reasons:

- **Blinding is not one field.** `notes` and `canonicalFacts` also carry what
  Realtime already wrote, and the reconciliation prompt *opens* by framing the
  task as comparison: "The realtime voice model has already written provisional
  notes. Compare those notes with the finalized transcript." Removing the
  proposals from a prompt built around them does not produce an independent
  reader; it produces a confused one.
- **It cannot recover an omission.** Where Realtime proposed nothing — the case
  the whole scope exists for — there is no candidate to compare against, so
  withhold-then-compare yields no second reading at all.

So: a separate pass, given the full turn and the assistant question, asked only
what figures the client stated — no fact contracts, no notes, no canonical
facts, no proposals. It reads once per reviewed turn, not once per leaf. It is
**mandatory for any leaf with no Realtime candidate**, and the cheap
Realtime-candidate comparison is an additional check where a candidate exists,
never a substitute for it.

Disagreement is never a silent refusal — it is `request_clarification`. Two
careful readings disagreeing about a figure is exactly when a person should be
asked.

**What must survive unchanged.** The second reading is an addition, not a
replacement: T1 rejection obligations still schedule review and still carry
their raw spans, `uncoveredValueEvidence` still drives the review inventory,
per-occurrence review budgets still bound how often a figure is re-asked, and
the whole pass stays detached via `waitUntil`, off the reply path. A design
that quietly drops any of those has reintroduced the turn coordinator by
another name.

**This needs measuring before it is built, and disagreement rate is not the
measurement.** Two readings can agree on the same wrong interpretation, and
agreement is exactly what this design treats as permission — so correlated
error is the failure mode that matters, and counting disagreements cannot see
it. Shadow-run the second reading and record both:

- the disagreement rate, which sets the clarification cost; and
- **false agreement**, measured against a hand-labelled sample of turns. If two
  readings agree on a wrong figure at any material rate, agreement is not a
  safety property and this design should not ship.

### Supporting signals — useful, and not evidence

- **Per-fact plausibility ranges** from the Pack. Catches €2 and €2,500,000 as a
  monthly spend. Routes to clarification, never to silent acceptance, and is
  never counted as agreement.
- **Narrowest-span**, kept where it works: as a prompt rule the reviewer
  follows, and as a *reported* signal when a cited span looks ambiguous. Not a
  deterministic gate, because counting regions does not work.

### What deterministic code keeps owning

Unchanged: schema and fact identity, entity/owner existence and cardinality,
unit and cadence compatibility, revisions, idempotency, conflicts, permissions,
readiness, the confirmation barrier, and every calculation. The reviewer reads;
it never computes.

## Currency

Currency is part of the reading, under the same agreement rule as the amount,
with EUR as the stated jurisdiction default when nothing was spoken.

The interim fail-closed rule — an unattachable currency token in the quote
refuses the amount — is a stopgap that converts a silent wrong write into a
visible refusal. It should be retired by this design, which must fix the
positive case ("a hundred and eighty grand pounds" → GBP) rather than only the
unsafe one.

## Completion and categorical absence

Separate from numerics, and narrower than the removed version.

- An absence/completion operation must cite **both** the client turn and the
  assistant proposition it answers, and that proposition must be the one
  immediately preceding. "Yes." is meaningless without the question.
- The reviewer returns one of four explicit outcomes — categorical none,
  collection complete, clarification, retraction — never a boolean, so "no
  others" cannot collapse into "has none".
- Deterministic refusal: `confirmed_none` on a collection still holding active
  records is refused unless the same plan explicitly retires them. This is what
  stops a €350,000 mortgage surviving while liabilities are marked empty.

## How it is built

One idea, three moving parts.

**1. The independent reading** (`worker/src/consumer/turn_reading.js`). A small
model call given the client's finalized turn and the assistant question that
prompted it, asked one question: which figures did the client state? It sees no
fact contracts, no notes, no canonical facts and no proposals, so it cannot
agree with a candidate it was shown. It transcribes number words, refuses
arithmetic, and marks a range or a missing scale `ambiguous` rather than
choosing.

**2. The agreement gate** (`js/planning/reconciliation.js`). For a turn that was
independently read, that reading — not the deterministic scan — is the authority
on what figures exist. A proposed number is accepted when the reconciler and the
reading agree; otherwise it is refused. Because the reading REPLACES the scan
for such turns rather than supplementing it, the original inversion closes in
both directions at once: `2` stops being supported by "two and a half thousand",
and `2500` starts being.

Currency travels with the figure. A figure the reading marked `ambiguous`
supports nothing, whatever was proposed against it.

**3. The mode switch** (`CONSUMER_TURN_READING_MODE`):

- `off` (default) — no extra call, no behaviour change.
- `shadow` — the reading runs and every agreement and disagreement is recorded,
  but the verdict is unchanged. This is the measurement state.
- `apply` — the gate is authoritative.

Everything else is untouched: T1 obligations still schedule review, the coverage
inventory still drives it, budgets still bound it, and the whole pass stays
detached from the reply path.

## Where the old target suite went

`check-consumer-live-numeric-transcription.mjs` was the failing target written
before any of this existed. Its cases are now split across three places that
each test one thing properly, so it was removed rather than left permanently
red in no gate:

- refusals that must hold regardless of the reader →
  `check-consumer-reconciliation-safety.mjs`
- what the agreement gate does with a reading, including a wrong one →
  `check-consumer-turn-reading.mjs`
- whether the reader actually reads well, against labelled turns →
  `run-reconciliation-transcription-evals.mjs` (paid)

## Rollout

1. Plausibility ranges alone, in `shadow`. Independent of everything else.
2. The second reading in `shadow`, measuring disagreement AND false agreement
   against labelled turns. **Grant nothing** until both are known.
3. Reviewed-turn scope in `apply` only after 1 and 2 are quiet.
4. Completion/absence last, on its own.

`check-consumer-reconciliation-safety.mjs` stays green at every step. The
known-open truncation inversion it reports is closed by step 3, and closing it
is the acceptance criterion for this work.

## Open decisions

- **The cost of the second reading per turn**, and whether it can be batched
  across a turn's spans or skipped where a Realtime candidate already agrees
  with the reviewer.
- **Where plausibility ranges live.** They are Pack/contract data; inventing
  them in `reconciliation.js` would be the parallel data model the architecture
  forbids.
- **Whether agreement can ever be assumed** rather than checked — for instance
  where T1 already accepted a Realtime candidate and the reviewer proposes the
  same figure. Always asking is safe but costs conversational turns.
