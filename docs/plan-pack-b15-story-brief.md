# B1.5: the storyteller brief

Prepared 20 October 2026 for Gerry's review. Nothing here is built yet. B1.5 starts after this brief is approved, and it comes before the plan screen design (D2), because the screen is laid out around the story sections below.

B1 prices each route through the resource ledger and checks that it balances. B1.1 adds freed cash (a loan's repayment comes back after its native schedule ends) and stops each person's share of the yearly surplus at their own retirement year. B1.5 turns a priced plan into a story that follows the CFP Integrated Financial Planning method, told only with figures the code produced.

## Outcome

An AI storyteller writes one story per route. Code works out every fact the story may mention, finds the inefficiencies, builds the risks from stress runs of the existing engines, and checks that the story covers every required section in the method's order. The storyteller chooses which route recipes to show and writes the sentences. It never types a figure, never ranks routes and never gives advice.

Later, several agents can walk the same ledger in different ways (for example one per section, or one per goal). The facts, sections and checks below are the contract they all share, so changing who tells the story never changes what the numbers are.

B1.5 does not draw the plan screen (D2 and B3), write the authoring playbook (B4) or change any engine. It adds facts, checks and recipe expansion around the existing ledger.

## Rules carried from the plan

- Education only. Never "you should", "we recommend", "best", a ranking word, or a product or provider name. The existing banned-phrase list applies, plus "better", "worse", "cheapest", "smartest", "preferred" and "top" when used to compare routes.
- Narration types no figures, dates, percentages or calculated states. Every one is a placeholder the code fills.
- A story may refer to its own route and to the current position. It may not refer to another alternative.
- Routes are never ranked. They keep B1's neutral order: current first, then by cash committed.
- Protection is shown as the gap and the months savings last, never a cover amount, premium or product.
- Pension money is gross for growth and after relief for cash flow.
- Freed cash is timed from when a loan actually ends, as B1.1 does.

## 1. Story facts

Code computes these for every route and registers them as placeholders. The storyteller can only use registered keys. A key with no computed value (for example a solvency figure with no assets) fails the check if referenced.

### Current position

| Placeholder | Meaning | Source |
|---|---|---|
| `{position.leftOver}` | Yearly surplus or deficit before goal saving | Cash-flow chapter |
| `{position.leftOverWord}` | "a surplus" or "a deficit", chosen by code | Sign of the figure |
| `{position.spareCash}` | Cash above the emergency reserve, not already earmarked | Ledger |
| `{position.reserve}`, `{position.reserveMonths}` | The reserve and the months of spending it covers | Liquidity policy |
| `{position.netWorth}`, `{position.grossAssets}` | Net worth and total assets | Balance-sheet chapter |
| `{position.solvency}` | Net worth divided by total assets, as a percentage | Balance sheet |
| `{position.homeShare}` | The home's share of net worth (see decision 3) | Balance sheet |
| `{position.mortgageShare}` | Yearly mortgage repayments as a share of yearly bank take-home | Liability and cash flow |
| `{position.pressurePoints}` | Code-found list, in plain words, from the facts below | Ledger and chapters |

Pressure points are facts with no threshold that needs judgement: a yearly deficit; cash below the reserve; a loan that runs past a person's retirement year; a goal not covered in the current position; and savings that last fewer months than the reserve target if an income stops.

### Goals

For each goal, in the ledger's order: `{goals.<id>.title}`, `.state`, `.lumpSumNeeded` (cash today that would fund it in full), `.yearlyNeeded` (first-year amount that would fund it), `.routeCash` and `.routeYearly` (what this route gives it), `.firstShortYear`, `.firstMoneyYear` and `.coveredFromYear` (B1, as calendar years). The lump sum and the yearly amount are two alternative ways of funding a goal and are never added together; the route uses one way for each goal. An asset already used by a goal, such as a pension pot for retirement, is listed once under `{ledger.crossedOff}` and never offered again.

### Running surplus after each step

The method funds one step at a time and shows what is left after each. For each step in the ledger's order (any deficit, the reserve, each inefficiency the route deals with, then each goal), `{steps.<id>.cashAfter}` is the spare cash left and `{steps.<id>.surplusAfter}` the yearly money left in the first year that step is funded.

### Freed cash

One entry per B1.1 event, keyed by the liability or goal: `{freed.<id>.label}`, `.amount` (a year), `.fromYear`, and for loans `.endDate` from the native schedule. A credit card or other debt with no contractual end has no freed entry.

### Pension contributions

Per person: `{pension.<personId>.grossNow}`, `.costNow`, `.grossRoute`, `.costRoute`, `.extraGross`, `.extraCost` and `.relief`. Gross is what goes into the pension; cost is what leaves the household's money after relief. The relief-limit disclosures already in B1 are carried with them.

### Money left over, and a surplus in retirement

B1.1 keeps an already-retired person's share of the surplus, because it comes from retirement income (Gerry confirmed this on 21 October). Whatever a route leaves over each year after funding its goals is shown with two illustrations, worked out by code. Neither is advice, and neither names a product.

| Placeholder | Meaning | Source |
|---|---|---|
| `{leftOverAfterGoals.yearly}`, `.monthly` | Money left each year, and each month, after this route funds its goals | Ledger, first year |
| `{leftOverAfterGoals.cashAfter}` | That yearly amount kept in cash for the illustration period, at the central cash rate after DIRT | Central cash rate and the tax engine |
| `{leftOverAfterGoals.investedAfter}` | The same amount invested over the same period at the central growth rate for a diversified portfolio, after exit tax, including the deemed disposal every eight years | Central growth rate and the tax engine's fund rules |
| `{leftOverAfterGoals.years}` | The illustration period (decision 5) | Central assumption |

Both figures are also given in today's money. The invested figure carries the existing disclosures that its value can fall as well as rise, and it reappears under the "lower investment returns" risk.

When the surplus comes from retirement income, the story can also show how much more could be spent:

| Placeholder | Meaning | Source |
|---|---|---|
| `{retirementSurplus.spendMoreYearly}`, `.spendMoreMonthly` | The extra a year, and a month, that today's surplus allows without touching savings | Ledger |
| `{retirementSurplus.spendMoreWithSavings}` | The level extra a year, rising with prices, that the surplus plus the spare cash this route leaves above the reserve could fund until the age the net-retirement engine plans to (100 today) | Net-retirement engine |
| `{retirementSurplus.toAge}` | That age | Net-retirement engine |

These sit in the `cash_flow_after` section, and the review items in `check_next` include the illustration period and rates.

### Differences from the current position

For an alternative, `{current.<key>}` repeats any current-position fact and `{vsCurrent.<key>}` gives the difference, worked out by code: cash used, yearly money left in the first year, cash left, net worth after, months savings last, and each goal whose state changes (`{vsCurrent.goalsChanged}` as a list of titles). The sign is carried by a code-chosen word (`{vsCurrent.<key>Word}`: "more" or "less"), so the storyteller never decides a direction.

## 2. The issue list

Code scans every route for the method's "removing inefficiencies" step and lists what it finds as facts. An issue says what is true and what it costs; it never says what to do. Each issue has an ID, a code-chosen headline and its figures.

| Issue | Found when | Facts shown |
|---|---|---|
| `idle_cash_vs_debt` | Spare cash above the reserve while a loan costs more than cash earns after DIRT, using the central cash rate | Spare cash, the cash rate after tax, each such loan and its rate, the yearly interest difference on the smaller of the two amounts |
| `dear_debt` | A loan or card meeting the dear-debt definition (decision 2) | Each debt, its rate, balance, yearly cost and native end date, dearest first |
| `investment_at_a_loss` | An ordinary-CGT holding whose market value is below its stated base cost. Never when the base cost is missing or assumed | The holding, its value, its base cost and the loss the tax engine would record on a sale |
| `tax_due` | A stated tax liability (needs the new optional `taxDue` binding below) | The amount and its due date |
| `mortgage_could_be_shorter` | Spare cash above the reserve and a mortgage costing more than cash earns after tax | The native end date today, and the end date if all spare cash went to the mortgage, from the amortisation engine |

`tax_due` needs one new optional fact: `planningInputs.taxDue: [{liabilityId, dueDate}]`, binding a stated liability as tax owed. Nothing is inferred from a label.

The current position lists every issue it finds. An alternative lists the same issues and says, through code facts, which ones its changes deal with.

## 3. Story sections

A story is a structured object, not one text field. It sits beside the existing `narration` (kept for B0 and B1) as a new optional `story` field keyed by route ID. Every section is required, in this order, and the check refuses a story that drops, repeats or reorders one:

1. `current_position`: surplus or deficit, spare cash, net worth, solvency, pressure points.
2. `ledger`: resources available against resources required, one way of funding each goal, what is crossed off, and the running surplus after each step.
3. `protecting`: the reserve, then the protection gap and the months savings last.
4. `inefficiencies`: the issue list.
5. `goals`: one subsection per goal, in the ledger's order (loan goals, then dated costs soonest first, then the mortgage, then retirement).
6. `cash_flow_after`: yearly money left after funding, the freed-cash events, and each retirement year from which a person's share stops.
7. `net_worth_after`: net worth after the route's changes, and the difference from current.
8. `risks`: section 5 below.
9. `check_next`: section 5's review items.

Each section, and each goal subsection, has the five education-only parts. They are the course's Recommendation, Reason, Benefit, Trade-off and Next step, written without advice:

| Part | Key | Says |
|---|---|---|
| What the route does | `does` | The change, or that nothing changes |
| Why | `why` | The fact or method step behind it |
| What it gives | `gives` | The result, from the facts |
| What it costs | `costs` | What is given up, used or left short |
| What to check | `check` | What the person would look at or confirm next |

The check also refuses a story that:
- leaves out an issue the code found for that route (each issue's placeholder must appear in `inefficiencies`);
- leaves out a goal, a risk, a freed-cash event inside the ledger years, or a review item;
- mentions protection with any amount other than the gap and the months;
- types a figure, uses a ranking word, or references another alternative.

These are completeness and wording checks. Sentence quality remains B4's authoring playbook.

## 4. Route recipes

The storyteller chooses up to three recipes to show beside the current position. A route names its recipe, and code expands the recipe into B1 route changes from the household's facts and the issue list. The expansion and its source facts are kept in provenance. Recipes are never ranked, and the order on screen stays B1's neutral order.

| Recipe | Spare cash | Yearly surplus |
|---|---|---|
| `current` | Stays as it is | As today |
| `inefficiencies_first` | Clears dear debt, dearest first, then tax due, then goes to the mortgage | Funds the goals in the method's order |
| `soonest_goal_first` | Funds the soonest dated cost in full, then the next | Funds the remaining goals in order |
| `pension_led` | Funds dated costs as lump sums where it can, so the surplus is free | After the earlier goals' needs, goes to extra pension contributions with tax relief, up to the relief limit |

An alternative must still protect the reserve and balance every year, as in B1. If an expanded recipe does not balance, code lists the single goal moves that would make it balance, each one the smallest move within the client's stated flexibility (a later age in whole years, a lower or later target). The storyteller may pick one by its ID; code applies it and records the choice. It never types the moved value. A recipe that cannot balance within the flexibility is reported as not available for this household and is not shown.

For `pension_led`, code also lists the retirement moves within the stated flexibility that the remaining surplus can fund with relief (an earlier age, or a higher income). The storyteller may pick one by ID, or none.

A recipe with nothing to do (for example `inefficiencies_first` with no issues) is not offered.

## 5. Risks and review items

Each risk is a code fact from a stress run of an existing engine, using central, dated, approved stress sizes (decision 1). None is a forecast.

| Risk | Fact |
|---|---|
| An income stops | The protection gap and months savings last for each person, using the cash this route leaves |
| Interest rates rise | The yearly extra repayment on each mortgage and loan at the stress rate, and whether that year's surplus still covers it. The profile does not record fixed-rate periods yet, so every loan is stressed from now |
| Lower investment returns | The projected pension pot at the lower growth rate, against the required pot |
| Costs rise faster than prices | Each dated cost's lump sum and yearly amount at the higher cost inflation |
| Anything that relies on a sale | Each sale's net proceeds and tax, whether the base cost was assumed to be zero, and the shortfall if the sale value were lower by the stress size |

Review items for `check_next` are also code facts: any assumed zero base cost, any estimated bank pay, any announced but not yet enacted tax rate, each loan end and saving end within the ledger years, each retirement year, and the opening reserve.

## 6. Golden plans for B4

The five CFP case studies (Doyle, Gallagher, Shannon, Laune and McGowan) become plan packs, each checked against the course solution's figures. Gerry supplies the case notes and solutions.

- **They stay out of the public repository** (decision 4). The notes, solutions and the five packs live in a git-ignored local folder, for example `private/cfp-cases/`. `npm run check:golden-plans` runs them when the folder is present and reports "not present" otherwise, so CI and the public site never hold course material. Niamh and Dara remain the public sample.
- **What is compared.** Each case file records the solution's figures and the check compares them one by one: net worth, solvency, surplus or deficit, spare cash, the reserve, the ledger's resources and requirements, the order goals are funded in, and each goal's state. Figures that depend only on stated facts must match to the euro.
- **Known differences are written down, not hidden.** Where the course uses a different tax year, reserve policy or growth rate, the case file states the course figure, Planeir's figure and the reason. A difference with no recorded reason fails the check.
- B4's authoring playbook is written against these five cases.

## 7. The plan document

Update `docs/plan-and-routes-implementation-plan.md` so B1.1 and B1.5 sit after B1 and before D2, and D2 waits for B1.5's sections. Done in the same pull request as this brief.

## Decisions for Gerry

1. **Stress sizes for the risks.** Recommended defaults: interest rates 2 percentage points higher, pension growth 2 points lower, dated-cost inflation 2 points higher, and a sale value 20% lower. Kept with the central assumptions, dated and versioned.
2. **What counts as dear debt.** Recommended default: every loan and card other than the mortgage, listed dearest first with its rate, with no rate threshold. A threshold can be added later if the list is too long in practice.
3. **The home's share of net worth.** Recommended default: the home's value less its mortgage, as a share of net worth, so it reads as how much of the person's wealth is tied up in the home. The alternative is the home's full value over net worth, which can exceed 100%.
4. **Course material stays private.** Recommended default: as in section 6. The course notes and solutions are not published.
5. **How long the "keep it or invest it" illustration runs.** Recommended default: 10 years, using the existing central rates (cash at the central rate after DIRT; investing at the central 5% for a medium-risk diversified portfolio, after exit tax).

## Verification when built

- Every placeholder resolves from code for every route of the sample and the golden plans; a reference to another alternative fails.
- A story missing any section, part, goal, issue, risk or review item is refused, with the path.
- Each issue fires on a fixture built to trigger it and stays silent on one built not to, including a missing base cost for `investment_at_a_loss`.
- Each recipe expands deterministically, A–B–A and B–A–B give the same routes, and a balancing move never leaves the stated flexibility.
- Stress runs reuse the native engines and never change the unstressed figures.
- The cash and invested illustrations reproduce the central rates and the tax engine's DIRT, exit tax and deemed-disposal figures; a retired household's spend-more figures match the net-retirement engine.
- Existing B0, B1 and B1.1 checks, the consumer suite, stale exports and build stay green. No prompt-pack changes and no consumer activation.
