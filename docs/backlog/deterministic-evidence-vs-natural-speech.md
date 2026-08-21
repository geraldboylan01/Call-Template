# Deterministic evidence rules vs natural speech: the recurring Phase 4 class

**Status:** architecture backlog. Not to be redesigned as part of Phase 4.

This file started as a note about the confirmed-none grammar. By the end of
Phase 4 the same shape had appeared in a second rule, so it is recorded here as
one concern with two instances.

## Instance 1 — the confirmed-none grammar

## What we keep observing

`js/planning/confirmed_none.js` decides whether a client actually said they hold
none of something. It has now needed extending three times, each for a phrasing
no one had thought of, each found by a real conversation rather than by review:

| when | phrasing that was refused | fix |
|---|---|---|
| pension work | "there's only the one pension between us" | household language is not partner ownership |
| partner-none work | narrow citations of a clear sentence | read the client's turn, not the planner's quote |
| cross-module batch | "neither of us owns or has an interest in a business" | "neither of us" is a negation in its own right |

Every fix was correct and narrow. The pattern is the finding: English has many
ways to say "we don't have any", and enumerating them is unbounded work with a
long tail that only real clients discover.

## Why it has not been redesigned

The current rule has a property worth keeping: it is DETERMINISTIC and it fails
closed. A client who never said an absence never gets one recorded, and the
marker it writes closes a module's need for a person's holdings — so a looser
rule decides whether a module runs on a household it does not know.

## What a better approach probably combines

- **semantic interpretation** — a model reading the turn, which handles phrasing
  variety without enumeration;
- **exact transcript evidence** — the span must still be a real thing the client
  said, as now;
- **deterministic owner/entity/scope validation** — the absence must still be
  bound to a person and a collection by code, never by the model's say-so.

The invariant to preserve through any redesign, unchanged:

> Absence must be explicitly evidenced. Omission must never mean none.

## Known remaining gap, deliberately not fixed

"Our house is the only property we own" is NOT treated as a confirmed none, and
should not be: the household owns a property, so recording "none" would be
false. It is a COMPLETENESS statement ("no additional positions"), which is a
different concept — `completionFacts.completedPaths` — and the live lane
deliberately refuses to set it (`live_complete_section_unsupported`). If we want
"the only X" to close a collection, it belongs in that mechanism, with its own
safety analysis, not in the absence grammar.

## Instance 2 — the numeric evidence guard

`numericOccurrenceSupportsSlot` in `worker/src/consumer/live/live_tools.js` has
needed the same kind of extension, for the same reason, at least four times:

| phrasing | what was refused |
|---|---|
| "My pension is worth EUR 319,000" | the model typed it `occupational`, so adviser vocabulary was demanded next to the figure |
| "I'm on 95,000 a year" | none of earn/income/salary/wage/gross/net present |
| "I am on 4.1 percent" | same idiom, for a mortgage rate |
| "Our main asset is our house, worth about EUR 420,000... we have about EUR 25,000 in savings... my pension is about EUR 90,000" | three positions in one utterance, all refused (`pbs_medium`, twice) |

The last row is the one still open. Each figure maps unambiguously to a
DIFFERENT collection, so there is no real ambiguity about which is which — but
the guard counts numbers rather than distinguishable slots.

## Why these belong together

Both rules are deterministic, both fail closed, and both are correct in what
they refuse. Their shared weakness is that they enumerate the ways people speak,
and people keep speaking in new ways. Every extension so far was found by a real
conversation, never by review.

The same three-part shape is likely the answer for both: semantic
interpretation for the phrasing, exact transcript evidence for the claim, and
deterministic validation for owner, entity and scope.
