# B1.5: the storyteller brief

Prepared 20 October 2026 for Gerry's review. Nothing here is built yet. B1.5 starts after this brief is approved, and it comes before the plan screen design (D2), because the screen is laid out around the story sections below.

B1 prices each route through the resource ledger and checks that it balances. B1.1 adds freed cash (a loan's repayment comes back after its native schedule ends) and stops each person's share of the yearly surplus at their own retirement year. B1.5 turns a priced plan into a story that follows the CFP Integrated Financial Planning method, told only with figures the code produced.

## Outcome

An AI storyteller writes one story per route. Code works out every fact the story may mention, finds the inefficiencies, builds the risks from stress runs of the existing engines, and checks that the story covers every required section in the method's order. The storyteller chooses which route recipes to show and writes the sentences. It never types a figure, never ranks routes and never gives advice.

Later, several agents can walk the same ledger in different ways (for example one per section, or one per goal). The facts, sections and checks below are the contract they all share, so changing who tells the story never changes what the numbers are.

B1.5 does not draw the plan screen (D2 and B3), write the authoring playbook (B4) or change any engine. It adds facts, checks and recipe expansion around the existing ledger, puts every dated cost behind one contract (section 6a) and starts the stress registry (6c). B1.6 adds the one retirement-years run (6b), the later-life stresses, and the growth, gift and later-life stories (section 5), with the engine and tax-rule changes they need.

## Rules carried from the plan

- Education only. Never "you should", "we recommend", "best", a ranking word, or a product or provider name. The existing banned-phrase list applies, plus "better", "worse", "cheapest", "smartest", "preferred" and "top" when used to compare routes.
- Narration types no figures, dates, percentages or calculated states. Every one is a placeholder the code fills.
- A story may refer to its own route and to the current position. It may not refer to another alternative.
- Routes are never ranked. They keep B1's neutral order: current first, then by cash committed.
- Protection is shown as the gap and the months savings last, never a cover amount, premium or product.
- Pension money is gross for growth and after relief for cash flow.
- Freed cash is timed from when a loan actually ends, as B1.1 does.

## 1. Story facts

Code computes these for every route and registers them as placeholders. The storyteller can only use registered keys. A key with no computed value fails the check if referenced.

Some facts cannot be computed for some households: solvency with no assets, the home's share with no home, mortgage repayments as a share of take-home with no mortgage or no take-home. For each, code registers a reason instead, `{<key>.notApplicable}`, a code-chosen plain sentence such as "There are no assets yet to measure against." Wherever a section requires that fact, the check accepts the figure or its reason, never neither, so a valid household can always be told.

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
| `investment_at_a_loss` | An ordinary-CGT holding with a stated base cost whose sale the tax engine would record as a loss. Found from the engine's own disposal result, after stated selling costs, never by comparing market value with base cost, so a loss made by selling costs is not missed. Never when the base cost is missing or assumed | The holding, its value, its selling costs, its base cost and the loss the tax engine records |
| `tax_due` | A stated tax liability (needs the new optional `taxDue` binding below) | The amount and its due date |
| `mortgage_could_be_shorter` | Spare cash above the reserve and a mortgage costing more than cash earns after tax | The native end date today, and the end date if all spare cash went to the mortgage, from the amortisation engine |

`tax_due` needs one new optional fact: `planningInputs.taxDue: [{liabilityId, dueDate}]`, binding a stated liability as tax owed. Nothing is inferred from a label.

The current position lists every issue it finds. An alternative lists the same issues and says, through code facts, which ones its changes deal with.

## 3. Story sections

A story is a structured object, not one text field. It sits beside the existing `narration` (kept for B0 and B1) as a new optional `story` field keyed by route ID. Every section is required, in this order, and the check refuses a story that drops, repeats or reorders one:

1. `current_position`: surplus or deficit, spare cash, net worth, solvency (or its reason when there are no assets), pressure points.
2. `ledger`: resources available against resources required, one way of funding each goal, what is crossed off, and the running surplus after each step.
3. `protecting`: the reserve, then the protection gap and the months savings last.
4. `inefficiencies`: the issue list.
5. `goals`: one subsection per goal, in the ledger's order (loan goals, then dated costs soonest first, then the mortgage, then retirement).
6. `cash_flow_after`: yearly money left after funding, the freed-cash events, each retirement year from which a person's share stops, and the section 5 stories that apply.
7. `net_worth_after`: net worth after the route's changes, the difference from current, and where section 5 applies, assets at retirement and what is left at 100, or the age money runs out.
8. `risks`: section 7 below.
9. `check_next`: section 7's review items.

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

Code projects the assets to retirement, then through retirement to age 100 in the retirement-years run (6b), for each allowed investment version. Placeholders, under each version: `{growth.<mix>.pensionExtra}`, `.investedYearly`, `.atRetirement`, and either `.runsOutAtAge` or `.at100`, with a year-by-year series for the screen's chart (chart data, not narration). Extra employer contributions for business owners are not modelled in this first version.

### Spending more in retirement

When a surplus comes from retirement income (B1.1 keeps it), the story shows `{retirementSurplus.spendMoreYearly}` and `.spendMoreMonthly`, the extra that surplus allows without touching savings. It also shows `{retirementSurplus.spendMoreWithSavings}`, the level extra a year, rising with prices, that the surplus plus the spare cash this route leaves above the reserve could fund until age 100. Code finds it as the largest extra yearly outgoing the retirement-years run (6b) can carry to 100, for each allowed investment version.

### If one of you died

For a couple, code works out the survivor's income rather than assuming it stops:
- a DC pot not yet drawn is paid to the spouse as cash, tax-free between spouses (Revenue's death-benefit limits to be confirmed at build);
- an ARF passes to the spouse as an ARF, keeps paying at least the required minimum each year and grows at the after-retirement rate of the version shown;
- a DB pension pays the spouse the scheme's spouse's percentage (50% central default);
- State payments follow the existing stated survivor contract; nothing is assumed.

The story shows the survivor's yearly surplus or shortfall and how long savings would last. This is the registry's `one_of_you_dies` entry (6c): an income change to the retirement-years run (6b), never a separate model. For a working couple, the protection chapter's existing cases stay as they are.

### Gifts to children

When there are children and money left over after the goals, each parent gives each child up to the small gift exemption every year: €3,000 per giver per child today, so €6,000 a year from two parents. Code reads the figure from the tax engine; the story never types it. If the money left over does not cover the full amount, code uses what is left, split evenly between the children. The gifts are invested after exit tax and deemed disposal, under each allowed investment version. The story shows the value at each child's 21st, 25th and 30th birthdays, for example towards a home deposit: `{gifts.<dependantId>.yearly}`, `.at21`, `.at25`, `.at30`.

Gift and inheritance tax figures use the household's wealth as it is today. A projection is never treated as the wealth that will be passed on. A gift planned for a year or two ahead can use the same engine with the rules dated for that year, applied to today's figures.

This needs gift tax (Capital Acquisitions Tax) rules in the shared tax engine, dated and versioned like the other tax rules. Budget 2027 raised the group thresholds to €420,000 (Group A), €44,000 (Group B) and €22,000 (Group C), reported to apply from 7 October 2026, and announced no change to the €3,000 small gift exemption. Confirm both against the Finance Act before use.

### Care costs

Long-term care is its own module (PR #89). It joins the plan in two ways: a relative's care the household pays for is a dated cost through the contract (6a), and the household's own later-life care is the registry's `one_of_you_needs_care` stress (6c).

## 6. Shared pieces every module plugs into

Three pieces, so every module joins the plan the same way and two answers to the same question can never disagree. No module adds its own branch to the ledger or its own model of the later years.

### 6a. The dated-cost contract

Every dated cost reaches the ledger in one shape, whichever module produces it: college, the future cost fund, and the care costs module (PR #89) for a relative's care. `resource_ledger.js` has one path for dated costs instead of a branch per module.

A producer is one function. It takes the cost's facts, the calculation date, the cash a route puts towards it today, and each payer's retirement year from B1.1, and returns:

| Field | Meaning |
|---|---|
| `costId`, `goalId`, `producer` | Which cost and goal, and the module and version that produced it |
| `payerIds` | The people who pay it |
| `costByYear[]` | For each calendar year it falls due: the amount due before relief, any tax relief with the person who claims it (`claimantId`) and the rules version, and the amount after relief |
| `moneyNow` | The lump sum that would meet it in full today, at the central cash rate after DIRT, less the cash the route already puts towards it |
| `moneyEachYear[]` | For each calendar year, what the household pays that year instead (saving before the cost starts, or paying as it falls due), after relief |
| `retirementSplit` | The years of `moneyEachYear` before and after the year every payer's working share of the surplus has stopped (B1.1's rule; a payer already retired never splits them), and `capitalNeededAtRetirement`, the lump sum at that year that would meet the later years |
| `assumptions`, `provenance` | The central rates, rules versions and inputs used |

How the ledger uses it:
- **Money now and money each year are two ways of funding the same cost and are never added together.** A route's `useCash` (`whole`, `remaining` or an amount) sets the cash towards it, and the producer works out `moneyEachYear` again for that cash. A part lump sum therefore works the same way for every module.
- **Each year's need is the producer's own figure.** It can change from year to year (a care cost falls when the home part stops), so the ledger never repeats one figure.
- **Years after retirement move to retirement.** The ledger funds the years before the split from the yearly surplus, and adds `capitalNeededAtRetirement` to the retirement goal, shown under retirement as the cost's name followed by "after retirement". Without this, those years would show as unfunded with no explanation.
- **Relief is counted once**, inside the producer's after-relief figures, from the shared tax engine at the claimant's real rate: gross for the cost, after relief for the household's money, as with pensions.
- College and the future cost fund move behind the contract with no change to their figures. A test pins today's sample results to the cent.

### 6b. One retirement-years run

There is one projection of the retirement years for each route and each allowed investment version. It runs from the first person's retirement (or from now, for a household already retired) until the youngest person in the household turns 100, as the pension and net-retirement engines already plan. Each year it records:
- **income:** State Pension, DB pensions (rising with prices), other stated retirement income, and ARF withdrawals (at least the required minimum);
- **outgoings:** retirement spending (the retirement goal's net income target, rising with prices), any loan still running, and the later years of any dated cost from 6a;
- **drawing to meet a shortfall,** in a fixed order (decision 6): ARF beyond the minimum, then savings above the reserve, then investments outside the pension, then the reserve last;
- **balances** at the end of the year: each pension or ARF, savings, and investments outside the pension. It also records the age money runs out, if it does, otherwise what is left at 100, in money of the day and in today's money.

The starting balances come from the route: pension pots projected to retirement with the route's contributions, the cash the route leaves, and any investments a section 5 story makes. The yearly surplus before retirement is not assumed saved unless a story saves it, as in B1. Growth uses the version's after-retirement rate. The run is built from the existing engines (the pension engine's drawdown and ARF rules, and the net-retirement engine's shortfall path), not a new formula.

Everything about the later years reads this run: "Money running out", "Growing wealth after the goals", "Spending more in retirement" and "If one of you died".

**A stress is a change to the run, never a new model.** A later-life stress applies one change and runs it again. There are three kinds:
- an extra outgoing in given years (for example care fees);
- an income change from a given year (for example a death: that person's own pensions stop and the survivor receives what section 5 lists);
- a return change (for example a lower growth rate).

The change goes through one options-only hook that receives the run's state at the start of each year (incomes, balances, ages) and returns that year's change. It is never reachable from a payload. It generalises the hook the care brief (PR #89) describes for `js/net_retirement_math.js`. With no change, the run's figures are exactly the base run's.

### 6c. The stress registry

Every stress is one registry entry, kept with the central assumptions. The risks section, the storyteller and the screen all read the same list.

| Field | Meaning |
|---|---|
| `id`, `name` | A stable ID and the plain name shown |
| `size` | The central size, with its unit, source, checked date, version and approval status |
| `appliesTo` | `ledger` (the years before retirement), `retirementRun` (6b), `datedCost` (worked out again through 6a) or `sale` |
| `change` | `extraOutgoing`, `incomeChange`, `returnChange`, `rateChange`, `costInflationChange` or `saleValueChange` |
| `who` | `household`, or `eachPersonInTurn` |
| `reports` | The facts it registers for the story |
| `status` | `live`, `waitingForApproval` (its size is not approved yet) or `waitingForEngine` |

The entries:

| ID | Name | Size | What it changes | What it reports | Status |
|---|---|---|---|---|---|
| `income_stops` | An income stops | The protection chapter's stated cases | `ledger`: the protection chapter's own cases | The gap and the months savings last, for each person | Live |
| `rates_rise` | Interest rates rise | 2 points higher (decision 1) | `ledger` and `retirementRun`: `rateChange` on every mortgage and loan from now | The extra yearly repayment, and whether that year's surplus or retirement income still covers it | Waiting for approval |
| `lower_returns` | Lower investment returns | 2 points lower (decision 1) | `retirementRun` and the pension projection: `returnChange` on the version shown | The pot against the required pot, and the age money runs out or what is left at 100 | Waiting for approval |
| `costs_rise_faster` | Costs rise faster than prices | Dated-cost inflation 2 points higher (decision 1) | `datedCost`: `costInflationChange`, worked out again through 6a | Each dated cost's money now and money each year | Waiting for approval |
| `sale_value_lower` | A sale fetches less | 20% lower (decision 1) | `sale`: `saleValueChange` | The net proceeds, the tax, and the shortfall against what the route uses | Waiting for approval |
| `one_of_you_dies` | If one of you died | Each person in turn (decision 5) | `retirementRun`: `incomeChange`, as section 5 lists | The survivor's yearly surplus or shortfall, how long savings last, and whether money runs out before 100 | Waiting for its engine (B1.6) |
| `one_of_you_needs_care` | One of you needs care | Each person in turn, in care from age 85 to 90 (the care brief's `care.ownCareStress`) | `retirementRun`: `extraOutgoing` each year, supplied by the care engine from the run's state that year | How long savings last, what the partner at home is left with each year, whether money runs out before 100, and any Nursing Home Loan in today's money | Waiting for its engine: live once the care engine (PR #89) exists |

The care entry follows the care brief's rules: a person already 85 or older starts now and still runs five years, a one-person household has one run, two people in care at the same time is not run, and the home part and the relief follow that brief's settings.

"Money running out" is not a stress. It is the base run's own fact, shown in the risks section beside the stresses.

## 7. Risks and review items

Each risk is a live entry in the stress registry (6c), run through the change it names. None is a forecast. The risks section reports every live entry that applies to the route, plus the retirement-years run's own "Money running out": the age the pension, ARF and savings run out before 100, if they do. The check refuses a story that leaves one out. An entry waiting for approval or for its engine is not shown.

Review items for `check_next` are also code facts, including the investment mixes and growth rates used and the client's stated preference: any assumed zero base cost, any estimated bank pay, any announced but not yet enacted tax rate, each loan end and saving end within the ledger years, each retirement year, and the opening reserve. Where the care stress is shown, the review items also carry the care brief's plain statements about Fair Deal, with no figures.

## 8. Golden plans for B4

The five CFP case studies (Doyle, Gallagher, Shannon, Laune and McGowan) become plan packs, each checked against the course solution's figures. Gerry supplies the case notes and solutions.

- **They stay out of the public repository** (decision 4). The notes, solutions and the five packs live in a git-ignored local folder, for example `private/cfp-cases/`. `npm run check:golden-plans` runs them when the folder is present and reports "not present" otherwise, so CI and the public site never hold course material. Niamh and Dara remain the public sample.
- **What is compared.** Each case file records the solution's figures and the check compares them one by one: net worth, solvency, surplus or deficit, spare cash, the reserve, the ledger's resources and requirements, the order goals are funded in, and each goal's state. Figures that depend only on stated facts must match to the euro.
- **Known differences are written down, not hidden.** Where the course uses a different tax year, reserve policy or growth rate, the case file states the course figure, Planeir's figure and the reason. A difference with no recorded reason fails the check.
- B4's authoring playbook is written against these five cases.

## 9. The plan document

Update `docs/plan-and-routes-implementation-plan.md` so B1.1, B1.5 and B1.6 sit after B1, D2 waits for B1.5's sections, the care costs module joins track A, and the rules list carries the dated-cost contract, the one retirement-years run and the stress registry. Done in the same pull request as this brief.

## Decisions for Gerry

1. **Stress sizes for the risks.** Recommended defaults: interest rates 2 percentage points higher, pension growth 2 points lower, dated-cost inflation 2 points higher, and a sale value 20% lower. Kept with the central assumptions, dated and versioned.
2. **What counts as dear debt.** Recommended default: every loan and card other than the mortgage, listed dearest first with its rate, with no rate threshold. A threshold can be added later if the list is too long in practice.
3. **The home's share of net worth.** Recommended default: the home's value less its mortgage, as a share of net worth, so it reads as how much of the person's wealth is tied up in the home. The alternative is the home's full value over net worth, which can exceed 100%.
4. **Course material stays private.** Recommended default: as in section 8. The course notes and solutions are not published.
5. **When "If one of you died" happens.** Recommended default: each person in turn, at the start of the retirement-years run. It is the most demanding case for the survivor, because the survivor's income has to last longest.
6. **The order money is drawn in retirement.** Recommended default: ARF beyond the required minimum, then savings above the reserve, then investments outside the pension, then the reserve last. The run reports money as running out only when all of them are used.

Settled by Gerry on 21 October 2026: the four mixes and their rates (4%, 5%, 6% and 7%), medium risk before retirement and lower risk after as the base case, plans to age 100, gift and inheritance tax on today's wealth, DB pensions rising with inflation and paying a spouse 50%, and the investment-preference question as drafted in section 5 (four levels of risk, each with what a very bad year could do to €10,000, asked once and optionally in B2's intake). The bad-year figures still need a confirmed source before any client sees them.

## Verification when built

- Every placeholder resolves from code for every route of the sample and the golden plans; a reference to another alternative fails.
- A story missing any section, part, goal, issue, risk or review item is refused, with the path.
- Each issue fires on a fixture built to trigger it and stays silent on one built not to, including a missing base cost for `investment_at_a_loss` and a loss that only selling costs create (value €100, base cost €95, selling costs €10).
- A household with no assets, no home or no mortgage can still pass the check, with the code's reason in place of each missing figure.
- Each recipe expands deterministically, A–B–A and B–A–B give the same routes, and a balancing move never leaves the stated flexibility.
- Stress runs reuse the native engines and never change the unstressed figures.
- 6a: college and future-cost-fund figures through the contract equal today's to the cent; a part lump sum is worked out the same way for every producer; years after retirement move to the retirement goal exactly once, and relief is counted once.
- 6b: with no change, a stressed run equals the base run to the cent; "Money running out", growth, spend-more, survivor and care figures for the same route and version all come from one run and agree.
- 6c: every risk shown comes from a live registry entry; an entry waiting for approval or for its engine is never shown; each entry's change is the only difference from the base run.
- B1.6: no version above the stated preference, or above the base case when none is stated, is ever run or registered; a story using a growth version without the disclosure is refused; invested figures reproduce the central rates and the tax engine's exit tax and deemed-disposal figures; pension contributions stop at each relief limit before anything is invested outside; spend-more and survivor figures match the pension and net-retirement engines; gift figures use the dated gift tax rules and the children's actual birthdays.
- Existing B0, B1 and B1.1 checks, the consumer suite, stale exports and build stay green. No prompt-pack changes and no consumer activation.
