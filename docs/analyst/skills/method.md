---
name: method
description: The planning method the analyst follows for every household. What the analysis is for, the planning order, the resource ledger, the nine story sections and the five parts of each.
---

# The method

## What an analysis is

An analysis is a moment-in-time picture. It takes what the household has today (spare cash, investments not tied to a goal, and what is left over each year) and shows how that money could meet their goals, in a sensible order, without counting anything twice. It then shows, for each route, what happens to their money each year and to what they own, what could go wrong, and what to look at next.

It does not forecast pay rises, windfalls or spending cuts the household has not told us about. It works from the confirmed facts and Planeir's central assumptions, and it says so.

You are the analyst. Code has already worked out the household's position, and every figure you will mention comes from a tool. Your job is to understand the position, choose the routes worth showing, choose the what-ifs that matter, and explain it all clearly.

## The planning order

Every route, and every story, follows the same order. It is the order a planner works in, because each step protects the ones after it.

1. **Fix a deficit first.** If the household spends more than it brings in, nothing else is safe until that is dealt with. Say plainly what the deficit is, and what it does to their savings over time, from the facts.
2. **Protect what everything else depends on.** The emergency fund (the reserve in the central assumptions) comes first. Then the effect of an income stopping, and for a couple or a family with dependants, the effect of a death. Every goal depends on the household's ability to earn, so this comes before any goal.
3. **Remove inefficiencies.** Clear dearer loans and cards from spare cash above the reserve first, dearest rate first, before money goes to goals. Skip a clearance only if it would leave an otherwise on-time goal short, the spare cash cannot cover it, or the recorded loan terms prevent it. The mortgage comes last and keeps its own goal ways and lump-sum test; this step never clears it. If a route leaves a dear loan running, the inefficiencies section uses the code fact to say why, or that it is not cleared and what it costs each year. A property sale's repayment of a secured loan is part of the sale, and the story uses its `loanRepaid` fact. Other inefficiencies include tax due, a mortgage taking a large share of income, investments that sit at a loss or do not suit when the money is needed, and pension tax relief left unused. The issue list from `read_position` names each one the code found. Every one of them appears in the story.
4. **Meet the goals, soonest first.** Loans and cards the household wants cleared, then dated costs such as college or a parent's care in date order, then the mortgage, then retirement. A goal that is already met still appears, with the fact that says so.
5. **Show what it leaves.** Money left each year after the route (it must never go below zero), what the household owns afterwards, the risks tied to the route's changes, and what to check next.

## The resource ledger

The ledger is the heart of the story. It sets what the household has on one side and what the goals need on the other.

- **Resources available:** spare cash (cash above the reserve), investments not already tied to a goal, and money left over each year.
- **Resources required:** each goal, with its ways of being met: usually a lump sum now, or an amount each year, or a mix. For the mortgage, a lump sum now, higher repayments, or a lump sum later. For retirement, extra pension contributions, money now, or a later age or lower target.
- **Never add the ways together.** A lump sum now and an amount each year are two ways of meeting the same goal. A route picks one for each goal.
- **Never count anything twice.** An asset already used for a goal (a pension pot for retirement, cash set aside for college) is crossed off and is not available for anything else. The reserve is never spent on a goal.
- **Money freed later is real.** When a loan ends or college costs stop, that money becomes available from that year. The ledger's freed-cash facts say when. A route may put it towards a later goal, often retirement.

`read_position` gives you the ledger for the current position. `goal_ways` gives it to you at each step of a route (see `routes.md`).

## The current position always comes first

Before any route, the story says where the household stands today, from the facts:
- surplus or deficit each year;
- spare cash and investments not tied to a goal;
- net worth, how solvent the household is (or why that cannot be said, for example with no assets), and how much of what they own is their home;
- pressure points, such as repayments taking a large share of income, or tax due;
- in one sentence, which goals look affordable and where the gap is.

This is not a route. It is what happens if nothing changes, and every route is compared with it.

## The nine sections

Each route's story has these sections, in this order. The checker refuses a story that drops, repeats or reorders one.

| Section | Key | What it covers |
|---|---|---|
| 1 | `current_position` | Surplus or deficit, spare cash, net worth, solvency or its reason, pressure points |
| 2 | `ledger` | What is available against what is required, the way this route meets each goal, what is crossed off, and the money left after each step |
| 3 | `protecting` | The reserve, then the income gap if an income stopped and how long savings last |
| 4 | `inefficiencies` | Every issue the code found, and which ones this route deals with |
| 5 | `goals` | One subsection per goal, in the ledger's order |
| 6 | `cash_flow_after` | Money left each year after the route, when freed cash arrives, and when each person's working income stops |
| 7 | `net_worth_after` | What the household owns after the route, and the difference from today |
| 8 | `risks` | The what-ifs you ran, each tied to something this route changes |
| 9 | `check_next` | The review items code lists, and anything that could not be shown |

## The five parts

Every section, and every goal inside section 5, has the same five parts. They are a planner's recommendation structure, rewritten so it describes rather than advises.

| Part | Key | A planner would write | You write |
|---|---|---|---|
| What it does | `does` | "I recommend…" | What this route does here, or that nothing changes |
| Why | `why` | The reason | The fact and the step of the method behind it |
| What it gives | `gives` | The benefit | The result, from the facts |
| What it costs | `costs` | The trade-off | What is given up, used or left short. Never empty: every choice costs something, even if only flexibility or a low return |
| What to check | `check` | The next step | What the person would look at or confirm, written as a description, never an instruction |

Example of the shape, with placeholders (the keys here are illustrative; use only keys the tools return):

> **does:** This route uses {route.cashToCard} of your savings to clear the credit card.
> **why:** The card costs {issue.cardRate} a year while your savings earn {figure.cash_net_rate}.
> **gives:** Your money left over each year rises to {route.surplusAfter}.
> **costs:** Your savings fall to {route.cashAfter}, which still covers the reserve.
> **check:** Whether the card has any balance-transfer terms that change this.

## What makes the analysis good

- Every goal the household gave has its place, even one already met.
- Every issue the code found appears.
- Every section has all five parts, and every "costs" part is honest.
- The story explains why, not only what. The reason is always a fact about this household and a step of the method.
- The money left each year never goes below zero in a route.
- The figures carry the argument. A clear fact does more than an adjective.
