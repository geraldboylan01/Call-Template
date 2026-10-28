---
name: whatifs
description: Which what-ifs the analyst runs, why, and the floor every story must meet. Each risk in the story is a what-if result tied to the route's changes.
---

# What-ifs

A what-if asks what happens to a route if something goes wrong: an income stops, someone dies, rates rise, returns are lower, costs rise faster, or a sale fetches less. Each risk in the story is a what-if that code ran, never a guess and never a forecast.

## The floor

Every story has these, and the checker refuses one without them:
- **an income stopping, for every earner** (`incomeStops`);
- **a death, for a couple or a household with dependants** (`death`);
- **the emergency fund**, in the `protecting` section;
- **at least one risk tied to each route's main change**, citing that change. The current position changes nothing, so it needs none.

## Choosing the rest

Run a what-if when a fact about the household makes it matter, and cite that fact. Some common reasons:

| What-if | Run it when | It shows |
|---|---|---|
| `incomeStops` | Always, for each earner | The yearly gap and how long savings would last |
| `death` | A couple, or dependants | What the survivor would have each year, and which goals become short and when |
| `ratesRise` | A variable or tracker mortgage, a fixed rate ending soon, or a route that leans on a loan | The extra repayment and whether the money left each year still covers it |
| `lowerReturns` | A route that relies on pension or investment growth | The pot against what is needed, and whether money runs out |
| `costsRiseFaster` | A dated cost such as college or a parent's care | What each dated cost then needs, now and each year |
| `saleValueLower` | A route that sells a home, a property or an investment | The sale's net proceeds, and any gap against what the route uses |
| `care` | One of you needing care later in life | How long savings last and what the partner at home is left with (when live) |

Settings follow the same three sources as levers: a fact with its path, the central default, or a value inside the bounds with a reason that cites a fact. Use the central default unless a fact gives a reason not to.

## Writing the risks

- Each risk names what the route changed and what the what-if does to it. "This route puts your savings towards the mortgage; if one income stopped, savings would last {whatif.incomeStops.monthsSavingsLast}" is a risk. "Interest rates could rise" on its own is not.
- A risk is a description of a result, not a warning or a prediction. Calm, factual, no alarm.
- When a what-if ran without a fact it could have used (for example existing cover the person has not told us about), the result says so in plain words, and it appears in `check_next`.

## Protection wording

Protection shows the income gap and how long savings last, counting any cover the household has told us about.
- A stated payout appears as money received ("a lump sum paid on death, as you told us").
- A protected mortgage appears as cleared.
- Personal cover and cover from an employer stay separate.
- It never shows a cover amount needed, a gap against cover, a premium, a product or a provider. That is the line between education and advice.

## When a what-if cannot run

Some what-ifs wait for their engines, and some need a fact that is missing. If the floor needs one that cannot run, code records it as not shown, with the reason. The story says so in the affected section and in `check_next`. Never describe a result that was not calculated.
