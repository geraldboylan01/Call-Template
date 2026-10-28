---
name: missing-facts
description: When the analyst stops to ask for a missing fact, how it asks (once, through a short follow-up form), and how it writes a limitation when a fact is still missing.
---

# Missing facts

The analysis only uses facts the person confirmed. When one is missing, you never guess it, never assume zero, and never fill it from what seems likely.

## Ask as little as possible

Every question is a burden on the person. Ask only when no rule, central assumption or other confirmed fact gives the answer.

- **Fixed rules are never questions.** What a survivor receives from a DC pot, an ARF or the State follows set rules, and a DB pension uses the central spouse's percentage. Code applies them.
- **Work it out where code can.** A State Pension comes from years of contributions in Ireland and years caring at home, under the published rules; the person is asked for those simple facts at most, never what they expect to receive. Take-home pay comes from gross pay through the tax engine.
- **One simple fact beats one hard question.** "About how many years have you worked in Ireland?" is easy to answer; "What State Pension do you expect?" is not.
- **Never ask anyone to predict a State payment**, an entitlement or anything the figures register holds.

## Stop and ask, or carry on

Call `missing_facts` early. For each missing fact it lists the result it affects.

**Stop and ask** when a missing fact blocks something the story must have:
- anything the floor needs (each earner's income for `incomeStops`; who is in the household and their ages for `death`);
- the household's tax status (single, married or in a civil partnership, or widowed), because take-home pay depends on it;
- essential spending, if a route would use `spendLess`;
- how far a goal could move, if the only routes that work would move it;
- a sale's base cost or purchase date, if a route sells something.

**Carry on** when a missing fact only limits a detail. Write the story without it and say what it could not show.

## How to ask

- **Once.** Gather every question from `missing_facts` into one short follow-up form. There is only one follow-up round for an analysis.
- **Use the form's own questions** where they exist (an existing schema path). Propose a new question only when none fits, with a plain label and type.
- **Plain words.** Ask what the person knows ("What does your home insurance cost a year?"), never what they would have to work out.
- **Never ask the person to predict an entitlement**, such as a State payment they might get if they fell ill. Those come from the figures register as central assumptions.
- **Never ask for anything the register holds**, such as a tax band or a weekly rate.

Then stop. The person answers, confirms a new version of their details, and a fresh analysis starts from that version. Nothing from the earlier run is carried over.

## After the follow-up

The second run works from what it has. If a fact is still missing:
- a result that needed it is not shown;
- code writes a limitation naming the fact and the result;
- the story says so, briefly and plainly, in the affected section and in `check_next`. For example: "The price paid for your second property wasn't given, so the tax on selling it can't be shown."

A question the person left unanswered stays unknown. It is never treated as zero or as "none".
