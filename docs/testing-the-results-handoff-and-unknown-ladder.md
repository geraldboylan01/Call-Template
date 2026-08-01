# Testing guide — results handoff, unknown ladder, discovery facts

Covers everything on `claude/architecture-comparison-rlopo7`. Three levels, cheapest first.
Do them in order: level 2 is pointless if level 1 is red, and level 3 is expensive to debug if
level 2 has not run.

---

## Level 1 — free, offline, run right now

No keys, no deploy, no cost. This is the whole deterministic suite.

```bash
npm run check:consumer        # the full suite (~30 scripts)
npm run check:consumer-live   # the live lane specifically
npm run build                 # must leave the generated manifests byte-identical
```

**Expected:**

| Check | Expected |
|---|---|
| `check-consumer-live` | **483 assertions passed** |
| `check-consumer-live-compliance` | **471 assertions passed** |
| `npm run check:consumer` | exits 0, no `AssertionError` |
| `npm run build` | completes; `git status` shows no change to `js/planning/*.generated.js` |

If the assertion counts are *lower* than these, something regressed. They should only ever go up.

**What this level proves:** the bundle mapping round-trips through the real viewer contract; the
unknown ladder distinguishes unresolved from missing; `approximate` satisfies readiness where
`unknown` does not; a €200/month contribution converts to 6.9% and fails closed with no income;
the sign-up validator accepts real Irish addresses and rejects PPS/card numbers; both publish
guards hold.

**What it cannot prove:** anything about how a conversation actually goes, or whether a browser
renders any of it.

---

## Level 2 — the persona probe (paid, ~10 minutes)

This is the one that matters most, because it is the only thing that can tell you whether the
unknown ladder actually changes the two conversations that used to end with nothing.

```bash
OPENAI_API_KEY=sk-... npm run probe:live-personas
```

Single persona, to iterate faster:

```bash
OPENAI_API_KEY=sk-... npm run probe:live-personas -- --persona young_renter
OPENAI_API_KEY=sk-... npm run probe:live-personas -- --persona anxious_late_starter
OPENAI_API_KEY=sk-... npm run probe:live-personas -- --persona complex_household
OPENAI_API_KEY=sk-... npm run probe:live-personas -- --no-grade   # deterministic only, cheaper
```

It makes real model calls for the agent, the simulated client and the grader. No audio, no
WebRTC, no database — it drives the exact live prompt and the exact live tools.

### What to look for, in priority order

**1. Do `young_renter` and `anxious_late_starter` now deliver?**
Both now carry `shouldConfirm`, which asserts analyses actually *ran*. **These assertions are
landed unproven — they may fail on the first run, and that is the point.** A failing check is a
tracked defect; an absent one is a blind spot.

- If they pass: the ladder works.
- If they fail with `END: analyses were not run…`, read the transcript and find which rung was
  skipped. Most likely: the agent still accepted "I don't know" without asking for a ballpark.

**2. Does the agent ask for a rough figure before giving up?**
In the transcript, after any "I don't know", the next agent turn should ask for a ballpark, not
move on. This is the rung that costs nothing and does the most work.

**3. Is the retirement-age placeholder a last resort?**
`anxious_late_starter` should be *asked* for a retirement age — more than once, in different
words — before `use_approved_assumption` is used, and when it is used the agent must say out
loud that it is a placeholder that can be changed.

**4. Is `complex_household` over-asked?**
New persona, never run. Compare its captured-fact count against `young_renter`. A complex
household legitimately needs more, but check the agent is not simply running through a list. Also
check the three-analysis cap is *explained* to Donal rather than silently applied — he has more
goals than fit.

**5. Is `primary_pain_point` captured?**
`anxious_late_starter` asserts it. Look for the worry being recorded rather than only
sympathised with.

### Reporting honestly

The 29 July report was explicit that its transcripts were selected best runs, re-run until clean,
with no variance data. If a persona needs several attempts, say so. **Run the full sweep at least
twice** — a single clean pass of a stochastic system is a data point, not a result.

---

## Level 3 — the browser click-through (needs a deploy)

Nothing above touches a browser. This path has never run end to end.

### Prerequisites

**1. Apply migration 0015** to the adviser database. The code tolerates its absence — addresses
are silently skipped rather than the publish failing — so a missed migration will not announce
itself.

```bash
wrangler d1 migrations apply planeir-leads --remote
```

**2. Enable the flags** in the deployed environment. All default to `"false"` in
`worker/wrangler.toml`:

```
CONSUMER_JOURNEY_ENABLED         = "true"
CONSUMER_REALTIME_VOICE_ENABLED  = "true"
CONSUMER_LIVE_VOICE_ENABLED      = "true"
CONSUMER_MODULE_ROUTING_ENABLED  = "true"
CONSUMER_GOAL_ROUTING_ENABLED    = "true"
```

**3. Confirm** `SESSION_ADVISOR_NOTIFICATION_TO` is your address (it already defaults to
`geraldboylan@gmail.com`) and that the consumer database and encryption key are provisioned.

### The walk-through

Have a real meeting as a client, get to analyses running, then check each step:

| # | Step | Pass looks like | If it fails |
|---|---|---|---|
| 1 | Meeting ends, analyses run | Agent says they are ready | Not this work — check `confirm_and_run` |
| 2 | **Page navigates to results** | You land on the results view within a few seconds | The navigation fix (`94db4df`). Check `session.stage` reached `results` |
| 3 | **Box appears** | "Your complete analysis", clearly clickable, no copy button yet | `createPublishedAnalysisBox` — needs at least one result item |
| 4 | Box does **not** look dead | Normal panel, inviting, not greyed out | Deliberate — report it if it reads as disabled |
| 5 | Click it | Sign-up dialog opens: first name, last name, email, address | Dialog wiring in `app.js` |
| 6 | Submit | **Page does not navigate.** Box turns gold/illuminated, copy button appears top-right | Publish failed — check the browser console for the API error |
| 7 | Click the box again | Opens `app/session.html` in a new tab | Link construction |
| 8 | **The viewer** | Zoomed-out grid of your modules | This is the payoff — the reused client viewer |
| 9 | Click into a module | Its detail, **with charts and tables** | Charts are the thing the old results view never showed |
| 10 | Copy button | "Link copied" toast; paste it and it opens | Clipboard needs HTTPS or localhost |
| 11 | **Your inbox** | Email with the *advisor* link | Best-effort by design — never fails the publish, so check Worker logs |
| 12 | Advisor link | Opens the advisor view of the same session | |
| 13 | **Your pipeline** | The client appears, tagged as an AI meeting | `publishTarget: 'ai-meeting'` |

### Things worth deliberately breaking

- **Submit the form with an address containing a PPS number** (e.g. `12 Main St, 1234567T`) →
  should be refused with a clear message. Then `I live at 4 Grove Park, Cork` → should be
  **accepted**, because that phrasing was previously rejected by mistake.
- **Publish twice** → the second should not create a duplicate pipeline client (matched on
  normalised email).
- **Close the tab right after confirming** and reopen the session → the terminal results poll in
  `stop()` should still have landed you on results.

---

## Known limits

- **Level 1 proves contracts, not conversations.** Every assertion is deterministic; none of them
  can tell you whether the agent sounds like a person.
- **Level 2 proves conversations, not the product.** No audio, no barge-in, no latency. The live
  lane's central claim — that it replies fast because nothing awaits a model before speech — is
  still untested anywhere.
- **`desired_outcome` was deliberately not added.** Every fact in the catalogue is a closed,
  validated vocabulary, and a defensible one for "what would a good outcome look like" is an
  adviser's to author.
- **One provisional value exists** (retirement age 66, tracking the State Pension default). Every
  further entry is an adviser decision.
