# Overnight call testing — the prompt to give Codex

Paste everything below the line into Codex, then paste your client briefs where
it says to. It is written to be handed over unattended: it explains the tools,
the standard of evidence, and — importantly — where it must stop and leave a
decision for you rather than guessing.

Keep this file up to date when the harness changes. It is the handover
document, and a stale one sends an agent down paths that no longer exist.

---

You are testing and fixing Planéir, an Irish financial-planning app that holds
a spoken planning meeting with a member of the public, captures what they say
as structured facts, and runs deterministic analysis modules on the result.

Your job tonight: run realistic calls, find what breaks, fix it, and leave the
repository green and honestly documented.

## How to run a call

You play the client. A model does not play them for you — you read each reply
and decide what that person would say next.

```bash
node --env-file=.env.local ./scripts/agent-call.mjs start --caller=callers/<name>.md --id=<id>
node --env-file=.env.local ./scripts/agent-call.mjs say --call=<id> "what the client says"
node --env-file=.env.local ./scripts/agent-call.mjs state --call=<id>
node --env-file=.env.local ./scripts/agent-call.mjs finish --call=<id>
```

`OPENAI_API_KEY` is already in `.env.local`, which is gitignored. Never print
it, never copy it into a file, never pass it on a command line.

Only `say` costs money — it is the one command that calls the planner and the
renderer. `--call=<id>` lets several calls run at once; use it, because running
three callers one after another lets a fix or a fluke in one bleed into your
reading of the next.

After `finish`, render what the client actually sees:

```bash
node ./scripts/render-client-results.mjs agent-calls/<id>-result.json
```

That drives the real client view code. **Judge the output from that page, not
from the JSON.** A number that is correct in the JSON and unreadable on the
page is still a defect.

## The three callers

For every client brief below, create three caller files and run all three
concurrently. Same financial facts every time; only how the person speaks
changes. Copy the shape of `callers/dermot-easy.md`.

| File | Who they are |
|---|---|
| `<name>-easy.md` | Knows every figure, gives it precisely, uses the right words, never needs a question rephrased |
| `<name>-medium.md` | Has the figures but hedges — "around", "I think"; sometimes needs a question rephrased; hazy on percentages; asks what terms mean |
| `<name>-hard.md` | Can find any figure if asked plainly, but has very basic financial knowledge; does not know what a buyout bond or AVC is; has never worked out monthly spending; never invents a number |

Run the same opening for all three, then diverge naturally. The comparison is
the point: a fault that only appears for one caller tells you something a fault
that appears for all three does not.

## What counts as a finding

Report and fix these:

- A figure the client stated that did not reach the profile.
- A question asked more than twice, or asked after it was answered.
- A question whose answer the engine cannot accept in any wording — the worst
  class, because the client has no way out of it.
- Anything the assistant claims is saved that is not on the record.
- A raw internal value on the client's page: an enum, a null, a camelCase key,
  an unformatted or wrongly formatted number.
- An analysis that could not run, and the exact input it was short of.
- Jargon, a disclaimer nobody asked for, or a tone a real client would dislike.

The call driver prints blockers as it goes. They are deterministic — trust them
over your own reading of the transcript.

## How to fix

1. **Reproduce it in isolation first.** Call the mapper or the planner directly
   with the exact value and confirm the failure before changing anything.
   Several apparent "extraction failures" in this codebase turned out to be
   latency, and one turned out to be my own misreading of a field name.
2. **Fix the cause, not the symptom.** Do not widen a message, silence a
   warning, or special-case a fact id. If a contract exists in code but was
   never told to the planner, tell it — that has been the single most common
   root cause here.
3. **Add a regression test** in the suite that covers that area, with a comment
   saying what the failure looked like in a real call.
4. **Re-run the same call** and show the before/after.
5. **Never weaken a test to make it pass.** If a test fails, either the code is
   wrong or the test's expectation is wrong; say which and why.

## The standard of evidence

- Measure before optimising. Latency here is 4–12s per turn with no correlation
  to utterance length; anyone who "optimises" on an assumption about density
  will make it worse.
- Three samples is not a result. An earlier run of three made `reasoning: none`
  look strictly better; twelve samples showed it was worse on ranges.
- Quote the actual error code and the actual transcript line. "It seemed to
  struggle" is not a finding.

## Verify before you commit

```bash
npm run check:consumer
npm run check:consumer-realtime
npm run check:consumer-turn-parity
```

All three must exit 0. If `check:consumer-turn-characterisation` reports a
behaviour diff, read every line of it: it is showing you what your change did
to real conversations. Only run it with `--update` when the diff is what you
intended, and say so in the commit message.

## Stop and leave a note when

Do not decide these alone. Write the options and the evidence into
`docs/overnight-findings.md` and move on to the next call:

- A change to an **approved module intake contract** in `docs/modules/*.md`.
- A change to the **domain model** — a new pension type, a new goal type, a new
  entity.
- Anything that alters what an analysis **calculates**, as opposed to what it
  is given.
- Enabling a flag, touching `wrangler.toml` deployment values, or anything in
  `.github/workflows/`.
- A structural change to how the meeting is sequenced.

## What to leave behind

`docs/overnight-findings.md`, containing for each client brief:

- what broke, quoted from the transcript, with the error code
- the root cause, in one sentence
- what you changed, or why you stopped
- before/after evidence from a re-run
- a link to the rendered client page for the finished call

One commit per fix, with a message that explains the cause rather than
restating the diff. Leave the working tree clean.

---

## Client briefs

Paste them below. Each one is a real person's situation: age, income, spending,
property, savings, pensions, borrowings, dependants, and the questions they
actually want answered. Write them as prose exactly as they were given to you —
do not restructure them into fields, because the details a restructuring drops
are the ones a real conversation trips over.

### Brief 1

<!-- paste here -->

### Brief 2

<!-- paste here -->
