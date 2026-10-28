---
name: routes
description: How the analyst builds routes. Walking the ledger goal by goal with each goal's ways, doing it again for routes that differ, and using the levers, including major moves like moving to a smaller home, sized by code.
---

# Building routes

A route is one way the household could use its money to meet its goals. The story shows the current position and up to three routes beside it. Your job is to find the routes most worth showing for this household: different from each other, sound by the method, and honest about what each costs.

You have real freedom here. Code offers starting points; you choose, change them, or build your own. Code prices everything, so you can explore as much as the budget allows without doing any maths.

## Walking the ledger

This is how a planner builds a route, and how you build one.

1. Start from the current position. Note the spare cash and the money left over each year.
2. Take the goals in the ledger's order (see `method.md`): the reserve, protection, loans and cards, dated costs soonest first, the mortgage, then retirement.
3. At each goal, call `goal_ways` with the route so far. It tells you what is still available at that point, and prices each way of meeting the goal:
   - from the lump sum still available;
   - from the yearly money still available;
   - a mix of the two;
   - for the mortgage: a lump sum off the balance now, higher repayments, or the term set so it is cleared by the goal's age;
   - for retirement: extra pension contributions with tax relief, money now, or a later age or lower target within what the person said could move.

   It says whether each way meets the goal on time, and if not, by how much and when it falls short. It also lists the levers that would close the gap, with the smallest size of each.
4. Choose one way, with a reason. Add it to the route. The next goal will see less money.
5. Carry on to the last goal. Then price the whole route with `price_route`. The priced route is what the story uses; the walk was how you found it.

**Do the walk more than once.** The same household can reach its goals in quite different ways, and showing that is the point of the analysis. A planner typically works each goal's options out, then works through them again knowing what lump sum and yearly money are really left after the earlier goals. You do the same: walk again with different choices at the early goals, and see how the later goals change.

## What makes a route plausible

A route is worth showing when:
- it follows the planning order (it does not fund retirement while a dear loan runs and spare cash sits idle, unless it explains why);
- it stays inside what the person said could move (a goal's date or target, their investment comfort);
- it balances: the money left each year never goes below zero, and nothing is counted twice;
- the reserve is protected;
- it changes no more than it needs to;
- it differs from the other routes in a way the person would care about.

`price_route` refuses a route that breaks the rules it can test, with the path. Fix it or drop it.

## Three routes that differ

Aim for two or three routes that each tell a different story. Useful contrasts:
- **Cash first:** spare cash goes to the goals in the method's order (often clearing dear debt, then a lump sum towards the soonest dated cost or the mortgage), so the yearly money is free for later goals.
- **Keep the cash, use the yearly money:** savings stay as they are (beyond the reserve), and the goals are met from what is left over each year.
- **A different shape:** a goal moved within its flexibility, or a major lever (below), when the first two leave goals late or short.

`suggest_routes` composes walks like these for you, already priced, with what each changes and why. Start from them, but do not stop at them if this household needs something they do not offer.

Routes are never ranked. They are shown in the plan's neutral order (current first, then by how much cash each commits), and no story compares itself with another route.

## The levers

Every change a route makes is a lever. You choose the lever and its settings; code checks where each setting came from and prices it.

| Lever | What it does |
|---|---|
| `useCash` | Puts spare cash towards a goal: all of it, what is left, or an amount |
| `clearOutgoing` | Clears a loan or card from savings, so its repayment stops |
| `sellAsset` | Sells an investment with ordinary capital gains tax treatment; code works out the tax |
| `moveGoal` | A later date, a lower target, or a later retirement age, inside the stated flexibility |
| `pensionContribution` | Extra pension contributions, up to the relief limit; code works out the cost after relief |
| `spendLess` | Lowers yearly spending, never below essential spending |
| `tradeDownHome` | Sells the home and buys a cheaper one, now or in a given year |
| `sellProperty` | Sells a second property; the rent and its costs stop |

Every setting must come from one of three places, and you say which:
- **a fact about the household**, with its path;
- **the central default** for that lever;
- **a value inside the lever's bounds**, with a one-line reason that cites a fact. For example: "College costs end when the youngest finishes, which frees money for a later retirement goal (`/household/dependants/1/collegePlan`)."

Anything else is refused.

## Money freed later

When a loan ends, college stops or a dated cost finishes, the money it used becomes available from that year. The ledger's freed-cash facts say when and how much. A route can put it towards a later goal, often retirement. Mention it whenever it matters: it is often the difference between a goal met late and a goal met on time.

## Major moves

Sometimes the ordinary ways leave goals late or short. A planner then looks at bigger moves: moving to a smaller home, selling a second property, working longer than planned, or spending noticeably less. These can seem out there, but showing them is often the most useful thing an analysis does, because the figures make the choice clear.

`tradeDownHome`, `sellProperty`, a `spendLess` above its central bound, and a `moveGoal` that adds more than two years of work are **major**. The rules for them:

- **Show one when it earns its place.** When the ordinary ways leave a goal late or short, or when the facts make it natural (for example a large home with a mortgage taking a big share of income, or a rental that costs more than it earns). Your reason cites those facts.
- **Never guess its size.** `goal_ways`, `balancing_moves` and `suggest_routes` give the smallest size that brings the goals on time: the most a smaller home could cost, the latest a property could be sold, the fewest extra years of work. Use that size, or a size inside the bounds with a reason.
- **One per route.** A route uses at most one major move, so it stays readable, unless code reports that one alone is not enough.
- **Respect a "no".** If the person said they would not consider a move, do not show it. If they have not been asked, show it as an illustration, and say so in the story.
- **Tell the human side.** A move like this is personal as well as financial. The "costs" part says what it gives up beyond money (a home they know, an area, a rental income, years of work), and the "check" part names what they would want to think about. Let the figures carry the argument; do not push.
- **Usually beside, not instead of.** A major-move route usually sits beside a route without one, so the person can see what the move buys.

## When nothing works

If no route meets every goal on time, even with a major move, say so plainly in the story. Show the route that comes closest, what it leaves short, and by how much and when, from the facts. The person learns as much from an honest gap as from a route that works.

## Before you leave this stage

- Each route balances and differs from the others.
- Each has a reason tied to the method and to facts.
- Each lever setting has a source.
- Any major move is sized by code, and its human side is ready for the story.
