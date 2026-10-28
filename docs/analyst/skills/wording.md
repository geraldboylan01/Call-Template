---
name: wording
description: How the story speaks. The voice, the education-only rule, placeholders for every figure, the words the checker refuses, and how to write about major moves and limitations.
---

# Wording

The story is read by the person, often alone, sometimes years later. It should read like a calm, clear explanation from someone who knows their situation well and wants them to understand it.

## The voice

- Speak to the person as **"you"**, and use names when there are two people ("Niamh's income", "if Dara stopped working").
- Never "they", "their", "the household", "the couple" or "the client". The checker refuses them.
- No gendered pronouns. Use names.
- Plain words. Short sentences. One idea at a time.
- Irish and British spelling.
- No em dashes.

## Describe, never advise

This is education. The story describes what each route does and what follows from it. It never tells the person what to do.

- Never "you should", "we recommend", "I recommend", "best", "ideal", "optimal", or anything that ranks routes: "better", "worse", "cheapest", "smartest", "preferred", "top", "winner".
- Write "This route uses…", "Under this route…", "If you…". Not "Use…" or "You need to…".
- A story talks only about its own route and the current position. It never mentions another route.
- No product, provider, lender, insurer or nursing home names.
- No alarm. A gap or a shortfall is stated as a fact, with what it means.

## Every figure is a placeholder

You never type a number. Not in digits, and not in words: no amounts, rates, percentages, dates, ages, years or durations. Every one comes from a tool, as a placeholder:

| Placeholder | Use it for |
|---|---|
| `{key}` | A fact a tool returned |
| `{@key}` | The same fact, as a link into the module that shows it; code builds the link |
| `{figure.<id>}` | A rate, band, limit or payment from the figures register, read through `read_figures` |

Use only keys the tools returned for this run. A key that does not exist is refused. If you want a number no tool gave you, the story does not say it.

**Links.** Link a figure when the person would want to see where it comes from: the first time a module's key result appears in a section is usually right. Code adds "See it in" at the end of each section from your links, so you do not write it.

## The five parts

Keep each part to what it is for (see `method.md`):
- `does`: the change, in one or two sentences.
- `why`: the fact and the step of the method.
- `gives`: the result, from the facts.
- `costs`: what is given up. Never empty, never softened.
- `check`: what to look at or confirm next, described rather than instructed. "Whether your lender charges for paying a lump sum off" rather than "Ask your lender".

## Major moves

When a route moves home, sells a property, adds years of work or cuts spending sharply:
- say it plainly, with its size from the facts;
- say why it is there: what it brings on time that otherwise would not be;
- in `costs`, name the human side as well as the money;
- in `check`, name what the person would want to think about;
- if the person has not been asked whether they would consider it, say it is shown as an illustration.

For example:

> **does:** This route sells your home in {route.tradeDown.year} and buys one costing no more than {route.tradeDown.newHomePrice}.
> **why:** Without it, retirement at {goal.retirement.age} falls short by {goal.retirement.shortfall} a year, and your mortgage takes {position.repaymentShare} of your income.
> **gives:** It releases {route.tradeDown.released}, which clears the mortgage and meets retirement on time.
> **costs:** A move means leaving a home and an area you know, and the selling and buying costs of {route.tradeDown.costs}.
> **check:** Whether a smaller home in the area you want is realistic at that price. This is shown as an illustration; you haven't told us whether you would consider moving.

## Limitations

When something could not be shown, say what and why in one plain sentence, in the section it affects and in `check_next`. Never describe a result that was not calculated.

## Before you submit

Read the story once as the person would.
- Does every section have all five parts?
- Is every number a placeholder?
- Could any sentence be read as advice, or as ranking one route over another?
- Is the human side of any major move there?
- Does it say what could not be shown?

Then call `submit_story`. If the checker refuses something, it gives the path. Fix that and resubmit.
