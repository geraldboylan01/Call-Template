---
name: teach
description: Analyse a Planéir teaching case — a call where the adviser played the adviser and the app recorded what its rules would have done instead — and propose what, if anything, should be learned from the divergence. Use when the user asks to review, analyse, or teach from a teaching case, mentions teaching/pending, runs /teach with a case id, or has just finished a teach-call session. Produces a proposal for the adviser to approve, amend, or reject; never changes behaviour on its own.
---

# Teaching a Planéir case

Planéir has already done the deterministic half: it recorded what its rules
would have done, what the adviser actually did, and where those differ. **Your
job is the semantic half** — the part that needs judgement rather than a diff.

You are running under the adviser's own subscription. Do not make metered API
calls to do this analysis; the reasoning is yours.

## 1. Read the case

```bash
node ./scripts/teach-call.mjs list          # if you were not given a case id
```

Read, in this order:

1. `teaching/pending/<caseId>/context.md` — the case in prose, with the
   divergences and a map of which layer holds which kind of fix
2. `teaching/pending/<caseId>/bundle.json` — the full per-turn record
3. **The live repository files `context.md` points at.** Read them; do not work
   from memory. The manifests, the prompt and the fact registry are the current
   structure you are comparing the adviser against, and they change.

If the case ran `--offline`, say so plainly and stop: the extraction was the
regex fallback, so the baseline is not the real system's decision and nothing
in it is evidence about behaviour.

## 2. Capability gaps come first

Before any divergence, read the **"Scenarios the adviser wanted but could not
express"** section of `context.md`. Those are the highest-value findings in the
whole bundle, and they are **not lessons**.

A refused lever, or a what-if that computed figures identical to its base case,
means a real conversation reached for an assumption the existing
Prompt-Pack-approved capability cannot express. Put each one to the adviser as a
**capability question**:

    What you wanted to vary:  ...
    Why the module cannot:    ...
    What the Prompt Pack says the module can vary: ...
    What adding it would mean: ...

Then stop. **Never compile a capability gap into a lesson, and never widen a
module's levers to close one.** The catalogue in
`js/planning/scenario_catalogue.js` may only contain what the Master Prompt Pack
authorises; expanding it is a product decision the adviser makes explicitly,
outside this loop.

## 3. Scenario construction, then everything else

Analyse the scenario turns before anything else — it is the first teaching
priority. For each one, work out:

- did the adviser introduce a what-if where Planéir did not, or the reverse?
- when in the conversation, and why does that timing look right?
- which module, which lever, and why that lever rather than another?
- which value or alternative, and was it one scenario or several?
- how did it relate to the client's actual goal and circumstances?
- what did the adviser establish BEFORE running it?
- what generalisable planning principle does the behaviour demonstrate?
- where should that principle NOT generalise?

**Do not assume every difference is a lesson.** Say explicitly, for each one,
whether it is incidental (a different word, a different order that changed
nothing) or meaningful expert behaviour. An analysis that finds a lesson in
everything is not analysing.

## 4. Work out what each divergence means

For every divergence, answer all seven. Guessing at one is worse than saying
you cannot tell.

1. What did the adviser do differently from the existing rules?
2. What is the likely planning rationale? Their `/note` is the best evidence —
   quote it if there is one.
3. Does their behaviour genuinely appear preferable? **"No" and "unclear" are
   real answers.** An adviser can be inconsistent, or right for this client and
   wrong in general.
4. What is the generalisable principle, **if one exists**? `null` — a one-off,
   nothing to learn — is a first-class answer, and a review that never returns
   it is not reviewing.
5. When must this NOT apply? A lesson with no boundary cannot be guarded.
6. What are the risks of generalising it?
7. What regression and adversarial cases would prove it works and prove it has
   not over-generalised?

Then pick the layer. **A lesson may land at layer N only if it genuinely cannot
be expressed at N−1** — the layers cost wildly different amounts at runtime, and
`context.md` lists them with those costs. Layer 4 entries are paid for on every
turn of every call and must name what they displace. Layer 5 changes what a
number means: never propose it from a teaching case; take it to the adviser
directly.

## 5. Put it to the adviser, one at a time

Present each proposal in exactly this shape, in plain financial-planning
English. No code, no file paths, no layer numbers — those are your problem.

```
Planéir baseline:         what the existing system would have done
My behaviour:             what the adviser actually did
Interpretation:           why they behaved differently, and why it may be preferable
Proposed lesson:          the narrowest useful principle Planéir should learn
Boundaries/exceptions:    where this should not apply
Likely implementation layer: where the system should change
```

**Present them one at a time**, and name the layer yourself — the adviser is a
financial planning expert, not a developer, and should never be asked to
diagnose which layer a fix belongs in.

Then stop and ask. **Observing a divergence is not approval. Neither is "that's
interesting" or "makes sense".** Approval is the adviser accepting specific
written words.

Write your proposal to `teaching/pending/<caseId>/proposal.json`:

```json
{
  "proposedBy": "claude-code",
  "layer": 2,
  "principle": "... or null if there is nothing to learn",
  "oldBehaviour": "...",
  "newBehaviour": "...",
  "doNotApplyWhen": ["..."],
  "risks": ["..."],
  "tests": ["..."]
}
```

That file changes nothing. `teaching/pending/` is gitignored and no runtime code
reads it.

## 6. Record their decision

They may restate the lesson. **If they do, their words replace yours** and
become what is compiled.

```bash
node ./scripts/teach-lesson.mjs approve <caseId> --as="<their exact words>"
node ./scripts/teach-lesson.mjs approve <caseId> --accept-as-written
node ./scripts/teach-lesson.mjs reject  <caseId> --why="<why not>"
```

`approve` prompts at the terminal for confirmation. **If it refuses because
there is no terminal, that is the gate working — do not route around it.** Ask
the adviser to run the command themselves.

## 7. Only then, implement

```bash
node ./scripts/teach-lesson.mjs compile <lessonId> --artefact=<each file you changed>
```

`compile` refuses anything not approved with a matching hash. Every artefact you
change must carry the marker `planeir-teaching-lesson:<lessonId>` in a comment,
because `npm run check:teaching-lessons` fails the build if a compiled artefact
cannot be traced back to an approval.

Then, in order:

1. Add a focused regression test for the original case.
2. Add the neighbour cases from "do not apply when" — the same situation just
   outside scope, where the old behaviour was right. **If those change, the
   lesson has over-generalised: roll it back rather than shipping it with a
   caveat.**
3. Replay the original case and show the divergence is gone.
4. Run `npm run check:consumer`, `npm run check:consumer-realtime`,
   `npm run check:consumer-turn-parity`.

## Things you may not do

- **Never edit production rules, prompts, manifests or planning code before
  approval.** Not one line, however obvious the fix looks.
- **Never bump `LIVE_PROMPT_VERSION` or touch `.github/workflows/` or
  `wrangler.toml`** — those are deployment decisions and belong to the adviser.
- **Never widen a lesson after it was approved.** Editing it breaks the hash,
  which is deliberate: it needs approving again.
- If there is no generalisable lesson, say so and stop. A corpus of
  rubber-stamped lessons is worse than an empty one.
