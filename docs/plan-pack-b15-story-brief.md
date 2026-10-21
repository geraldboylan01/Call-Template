# B1.5: the storyteller brief

Prepared 20 October 2026 for Gerry's review. Nothing here is built yet. B1.5 starts after this brief is approved, and it comes before the plan screen design (D2), because the screen is laid out around the story sections below.

B1 prices each route through the resource ledger and checks that it balances. B1.1 adds freed cash (a loan's repayment comes back after its native schedule ends) and stops each person's share of the yearly surplus at their own retirement year. B1.5 turns a priced plan into a story that follows the CFP Integrated Financial Planning method, told only with figures the code produced.

## Outcome

An AI storyteller writes one story per route. Code works out every fact the story may mention, finds the inefficiencies, builds the risks from stress runs of the existing engines, and checks that the story covers every required section in the method's order. The storyteller chooses which route recipes to show and writes the sentences. It never types a figure, never ranks routes and never gives advice.

Later, several agents can walk the same ledger in different ways (for example one per section, or one per goal). The facts, sections and checks below are the contract they all share, so changing who tells the story never changes what the numbers are.

B1.5 does not draw the plan screen (D2 and B3), write the authoring playbook (B4) or change any engine. It adds facts, checks and recipe expansion around the existing ledger. B1.6 (section 5) adds the growth, gift and later-life stories, with the engine and tax-rule changes they need.

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

### Money left over after the goals

`{leftOverAfterGoals.yearly}` and `{leftOverAfterGoals.monthly}` give what a route leaves each year after funding its goals (ledger, first year). What that money could do is section 5.

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
6. `cash_flow_after`: yearly money left after funding, the freed-cash events, each retirement year from which a person's share stops, and the section 5 stories that apply.
7. `net_worth_after`: net worth after the route's changes, the difference from current, and where section 5 applies, assets at retirement and what is left at 100, or the age money runs out.
8. `risks`: section 6 below.
9. `check_next`: section 6's review items.

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

## 5. After the goals: growth, gifts and later life (B1.6)

These stories follow Gerry's direction of 21 October 2026. They need new central assumptions and gift tax rules in the shared tax engine, so they are built as B1.6, straight after B1.5, and do not hold up the plan screen. Each appears only when its condition is met, and then the check requires it. Every figure is worked out by code; none is advice or names a product.

**Shared assumptions**, settled by Gerry on 21 October 2026 and kept as central, dated, versioned values:
- Four investment mixes, each with a long-run growth rate. Clients see them as levels of risk, not as shares and bonds: lower risk (about 25% shares, 75% bonds) 4%; medium risk (50/50) 5%, the existing central rate; higher risk (75/25) 6%; highest risk (all shares) 7%. The shares-and-bonds split is available as a detail line for anyone who wants it.
- The base case is medium risk before retirement and lower risk after it, for DC pots and ARFs in drawdown. The pension module uses the same rates, so a chapter and the plan never disagree.
- Plans run to age 100, as the pension and net-retirement engines already do. The story shows the age money runs out, if it does; otherwise what is left at 100.
- Retirement income keeps pace with prices: DB pensions are assumed to rise with general inflation (2%), and DC income is drawn from an invested pot. A surplus from retirement income is therefore not shrunk by inflation.
- A spouse's DB pension is 50% of the member's, unless the scheme states otherwise.

### Investment versions and how the storyteller chooses

The engines do not run one answer. For each route and each story in this section, code runs every investment mix the client's stated preference allows, before and after retirement, and registers each version's figures under its mix, for example `{growth.medium.atRetirement}` or `{growth.higher.at100}`. The storyteller's job is to pick the versions that are feasible and realistic for this household and tell their story clearly, for example how much further a higher-risk mix would go than the base case, and what it would cost in a bad year.

- **Never above the stated preference.** The profile gains one optional fact, the client's stated investment preference (one of the four risk levels, or "not sure"). Code only runs and registers the mixes at or below it. With no answer, or "not sure", the ceiling is the base case: medium risk before retirement and lower risk after. Nothing assumes a client is comfortable with high risk.
- **The question.** B2's intake asks it in plain words, with no investment terms, recorded as stated, not as an assessment. Each option describes the trade-off and what a very bad year could do to €10,000:

  > To get more growth over the long term, investments have to go up and down more along the way. Which sounds most like you?
  > - **Lower risk.** I want steadier growth. In a very bad year, €10,000 might fall by about [fall].
  > - **Medium risk.** A balance between growth and steadiness. In a very bad year, €10,000 might fall by about [fall].
  > - **Higher risk.** More growth over time, with bigger falls. In a very bad year, €10,000 might fall by about [fall].
  > - **Highest risk.** The most growth over time, with the biggest falls. In a very bad year, €10,000 might fall by about [fall].
  > - **I'm not sure.**
  >
  > This question is not an assessment of what is suitable for you.

  Code fills each [fall] from a central, sourced, dated figure per mix, rounded to the nearest €500. The indicative source is Vanguard's worst calendar year for each stock and bond mix since 1926: about 10% to 14% at 20% shares, 18% at 40%, 27% at 60%, 35% at 80% and 43% at 100%. Interpolated to the four mixes, that is roughly €1,000, €2,000, €3,500 and €4,500 per €10,000. Confirm against Vanguard's own table, and a European or global series, before use.
- **Saying what was done.** Every screen and story that uses a growth rate shows this, with the risk level and rate filled in by code: "These illustrations assume a [lower/medium/higher/highest]-risk mix of investments growing at [rate] a year. Growth rates are assumptions, not predictions, and investments can fall as well as rise. No assessment of your attitude to risk, your capacity for loss or the suitability of any investment has been carried out, so this mix may not be suitable for you. Before making any investment decision, you may wish to get advice from a regulated financial adviser." The check refuses a story that uses a growth version without it.

### Growing wealth after the goals

Shown when a route covers every goal, protects the reserve and still leaves money over each year, after the reserve and protection sections. The order is fixed:
1. Personal pension contributions first, up to each person's relief limit (gross for growth, after relief for cash flow).
2. What is left is invested outside the pension, after exit tax, including the deemed disposal every eight years.

Code projects the assets to retirement, then through retirement to age 100, drawing income from the pension and ARF, for each allowed investment version. Placeholders, under each version: `{growth.<mix>.pensionExtra}`, `.investedYearly`, `.atRetirement`, and either `.runsOutAtAge` or `.at100`, with a year-by-year series for the screen's chart (chart data, not narration). Extra employer contributions for business owners are not modelled in this first version.

### Spending more in retirement

When a surplus comes from retirement income (B1.1 keeps it), the story shows `{retirementSurplus.spendMoreYearly}` and `.spendMoreMonthly`, the extra that surplus allows without touching savings. It also shows `{retirementSurplus.spendMoreWithSavings}`, the level extra a year, rising with prices, that the surplus plus the spare cash this route leaves above the reserve could fund until age 100, from the net-retirement engine, for each allowed investment version.

### If one of you died

For a couple, code works out the survivor's income rather than assuming it stops:
- a DC pot not yet drawn is paid to the spouse as cash, tax-free between spouses (Revenue's death-benefit limits to be confirmed at build);
- an ARF passes to the spouse as an ARF, keeps paying at least the required minimum each year and grows at the after-retirement rate of the version shown;
- a DB pension pays the spouse the scheme's spouse's percentage (50% central default);
- State payments follow the existing stated survivor contract; nothing is assumed.

The story shows the survivor's yearly surplus or shortfall and how long savings would last. For a working couple, the protection chapter's existing cases stay as they are.

### Gifts to children

When there are children and money left over after the goals, each parent gives each child up to the small gift exemption every year: €3,000 per giver per child today, so €6,000 a year from two parents. Code reads the figure from the tax engine; the story never types it. If the money left over does not cover the full amount, code uses what is left, split evenly between the children. The gifts are invested after exit tax and deemed disposal, under each allowed investment version. The story shows the value at each child's 21st, 25th and 30th birthdays, for example towards a home deposit: `{gifts.<dependantId>.yearly}`, `.at21`, `.at25`, `.at30`.

Gift and inheritance tax figures use the household's wealth as it is today. A projection is never treated as the wealth that will be passed on. A gift planned for a year or two ahead can use the same engine with the rules dated for that year, applied to today's figures.

This needs gift tax (Capital Acquisitions Tax) rules in the shared tax engine, dated and versioned like the other tax rules. Budget 2027 raised the group thresholds to €420,000 (Group A), €44,000 (Group B) and €22,000 (Group C), reported to apply from 7 October 2026, and announced no change to the €3,000 small gift exemption. Confirm both against the Finance Act before use.

### Care costs

Long-term care is its own module, briefed separately. Its costs join these stories once its engine exists.

## 6. Risks and review items

Each risk is a code fact from a stress run of an existing engine, using central, dated, approved stress sizes (decision 1). None is a forecast.

| Risk | Fact |
|---|---|
| An income stops | The protection gap and months savings last for each person, using the cash this route leaves |
| Interest rates rise | The yearly extra repayment on each mortgage and loan at the stress rate, and whether that year's surplus still covers it. The profile does not record fixed-rate periods yet, so every loan is stressed from now |
| Lower investment returns | The projected pension pot at the lower growth rate, against the required pot, and the lower-risk investment versions in section 5 |
| Costs rise faster than prices | Each dated cost's lump sum and yearly amount at the higher cost inflation |
| Money running out | The age the pension, ARF and savings run out before 100, if they do |
| Anything that relies on a sale | Each sale's net proceeds and tax, whether the base cost was assumed to be zero, and the shortfall if the sale value were lower by the stress size |

Review items for `check_next` are also code facts, including the investment mixes and growth rates used and the client's stated preference: any assumed zero base cost, any estimated bank pay, any announced but not yet enacted tax rate, each loan end and saving end within the ledger years, each retirement year, and the opening reserve.

## 7. Golden plans for B4

The five CFP case studies (Doyle, Gallagher, Shannon, Laune and McGowan) become plan packs, each checked against the course solution's figures. Gerry supplies the case notes and solutions.

- **They stay out of the public repository** (decision 4). The notes, solutions and the five packs live in a git-ignored local folder, for example `private/cfp-cases/`. `npm run check:golden-plans` runs them when the folder is present and reports "not present" otherwise, so CI and the public site never hold course material. Niamh and Dara remain the public sample.
- **What is compared.** Each case file records the solution's figures and the check compares them one by one: net worth, solvency, surplus or deficit, spare cash, the reserve, the ledger's resources and requirements, the order goals are funded in, and each goal's state. Figures that depend only on stated facts must match to the euro.
- **Known differences are written down, not hidden.** Where the course uses a different tax year, reserve policy or growth rate, the case file states the course figure, Planeir's figure and the reason. A difference with no recorded reason fails the check.
- B4's authoring playbook is written against these five cases.

## 8. The plan document

Update `docs/plan-and-routes-implementation-plan.md` so B1.1, B1.5 and B1.6 sit after B1, D2 waits for B1.5's sections, and the care costs module joins track A. Done in the same pull request as this brief.

## Decisions for Gerry

1. **Stress sizes for the risks.** Recommended defaults: interest rates 2 percentage points higher, pension growth 2 points lower, dated-cost inflation 2 points higher, and a sale value 20% lower. Kept with the central assumptions, dated and versioned.
2. **What counts as dear debt.** Recommended default: every loan and card other than the mortgage, listed dearest first with its rate, with no rate threshold. A threshold can be added later if the list is too long in practice.
3. **The home's share of net worth.** Recommended default: the home's value less its mortgage, as a share of net worth, so it reads as how much of the person's wealth is tied up in the home. The alternative is the home's full value over net worth, which can exceed 100%.
4. **Course material stays private.** Recommended default: as in section 7. The course notes and solutions are not published.
5. **The investment-preference question.** Recommended default: ask it as drafted in section 5, as one optional question in B2's intake, framed as four levels of risk with the bad-year euro figure on each. The bad-year figures need a confirmed source before they are shown. Wording is Gerry's to adjust.

Settled by Gerry on 21 October 2026: the four mixes and their rates (4%, 5%, 6% and 7%), medium risk before retirement and lower risk after as the base case, plans to age 100, gift and inheritance tax on today's wealth, and DB pensions rising with inflation and paying a spouse 50%.

## Verification when built

- Every placeholder resolves from code for every route of the sample and the golden plans; a reference to another alternative fails.
- A story missing any section, part, goal, issue, risk or review item is refused, with the path.
- Each issue fires on a fixture built to trigger it and stays silent on one built not to, including a missing base cost for `investment_at_a_loss`.
- Each recipe expands deterministically, A–B–A and B–A–B give the same routes, and a balancing move never leaves the stated flexibility.
- Stress runs reuse the native engines and never change the unstressed figures.
- B1.6: no version above the stated preference, or above the base case when none is stated, is ever run or registered; a story using a growth version without the disclosure is refused; invested figures reproduce the central rates and the tax engine's exit tax and deemed-disposal figures; pension contributions stop at each relief limit before anything is invested outside; spend-more and survivor figures match the pension and net-retirement engines; gift figures use the dated gift tax rules and the children's actual birthdays.
- Existing B0, B1 and B1.1 checks, the consumer suite, stale exports and build stay green. No prompt-pack changes and no consumer activation.
