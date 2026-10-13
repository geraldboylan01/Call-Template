# Goals and resources: can the money do everything you want, and what has to give?

Status: design chosen (option C, "have and need"). Priced through the engines for an **illustrative household, not real figures**. The pricing script is built and its figures below are from a run on merged `main` (13 October 2026, after PR #55), with pension money counted after income tax relief and goals taken in the planning method's order. The engine `js/goals_and_resources_math.js` is built and tested and runs in about 0.55 s. The screen and the wiring are not started.

## Changes decided 13 October 2026, evening

Both are written into the sections below. They change the script's figures, so rerun it before building the engine.

1. **Pension money: gross for growth, after relief for cash flow.** The search for the extra contribution stays in gross terms, because the pot grows on everything paid in. Wherever a contribution is counted against the household's money (needed this year, paid out over the life of the goals, the yearly ledger) it counts at its cost after income tax relief, taken from the tax engine. In the illustration the extra €15,435 a year saves about €6,174 of income tax (checked with `computeTaxYear` on `main`), so it costs about €9,300 a year. This is the same convention as the household cash flow module, where €10,000 paid in shows as €10,000 into pensions and €4,000 less tax.
2. **Goal order follows the planning method, not a stated priority.** The order is the one financial planners use to build a resource ledger (the CFP planning method): protection and the emergency reserve first (outside this module: the spare cash is already net of the reserve), then the goals that come soonest (each child's college, by start date), then the mortgage, then retirement. `goalPriorities` is removed from the payload. The engine applies the order and the assumptions table says so.

## Context

A household has several goals pulling on the same limited money. The question this screen answers is **can your money do everything you want, and if not, what has to give?** It is shared at 1920×1080 on a call while the adviser clicks between up to four cases, and re-opened later by the client alone on a laptop or phone, so it has to explain itself.

There are two pictures and they are never put on one scale: **money now** (spare cash, a one-off) and **money each year** (what is left over each year). Each goal can usually be paid either way, and the two ways are alternatives, never added together.

The idea it has to land: **the same household, with the cash used differently, needs a very different amount found each year, and the use that helps most this year is not the one that costs least over the life of the goals.**

This is a composition over three engines. It has no maths of its own.

| Goal | Engine | How a lump sum changes it |
|---|---|---|
| Mortgage cleared by an age | `js/mortgage_math.js` | `oneOffOverpayment` at month 0, `overpaymentBenefit: 'lowerPayment'`, term set to clear by that age. The yearly change is 12 × (the engine's repayment − today's repayment). It can be negative. |
| College, each child its own dated cost | `js/future_cost_fund_math.js` | `lumpShare` of the cost funded today, the rest saved yearly from today. |
| Retirement on a household target | `js/pension_math.js` | The personal contribution is searched through `computePensionProjection` until `currentGapVsRequired` is 0, capped at the age-related relief limit. The search is in gross contributions. What the extra costs the household each year is that amount less the income tax relief on it, from `computeTaxYear` with and without it (or `marginalTax`). |

## Reference frames

Design canvas (private link): https://claude.ai/artifact/9gArzoeM5VZDqnHN5Ld5Fp

| Frame | What it shows |
|---|---|
| `C1.dc.html` | 1920×1080, option C, engine-priced, case 1 selected |
| `C2.dc.html` | 1920×1080, option C, second frame. It starts on case 4; case 3 was intended and the edit did not land |
| `A`, `B` and `A on a phone` | Not chosen. Still on the first brief's placeholder figures, not engine-priced |

Things to know before using them:

- **They are stale against this brief, on purpose.** C1 embeds the output for the *previous* illustrative household (pots €180,000 and €90,000, targets €45,000 and €42,000, cases ranked by yearly need), and shows only "needed this year". They are **not redrawn yet, by decision**: every case is now short, and the red "short" state has not been designed. The frames are redrawn once that state exists, with both measures side by side. Until then the brief wins over the frames.
- They embed the script's output as literals in their own script block, so they are a drawing of an engine answer, not a reference implementation.
- They have not been opened and checked in a browser. Text fit and label collisions in the "money each year" ledger are unchecked.
- Where this brief and a frame disagree, the brief wins. Tell me which.

## What is built

`scripts/price-goal-cases.mjs` (`node scripts/price-goal-cases.mjs`, or `--json`). It carries the illustrative household as a constant, prices every way of using the cash through the three engines, and picks the four cases.

It imports `js/future_cost_fund_math.js` (on `main` since PR #55) and the tax engine's `computeTaxYear`, which it uses to cost each year's contributions after income tax relief.

### The engine

- `js/goals_and_resources_math.js`: `normalizeGoalsAndResourcesInputs`, `computeGoalsAndResourcesProjection(rawInputs, options)`, `getGoalsAndResourcesCases`, `getDefaultGoalsAndResourcesScenarioId`. Case ids are stable: `cash-stays`, `college-today`, `mortgage-all-cash`, `mortgage-then-college` for the sample household.
- **A helper in the retirement module.** `computePersonalContributionCosts(rawInputs)` in `js/pension_math.js` is additive: what the household's own personal contributions cost each year after income tax relief, from the tax engine. It reuses the module's own item-building (`householdTaxItemsAtYear`, extracted from `buildContributionNetCosts`, so the two describe the same household) and its relief limit. Nothing the retirement module shows has changed. Its two tests are in `js/tests_pension_math.js`.
- **The search.** The projected pot is exactly linear in the contribution below the relief cap (the same slope to the euro at every point), so a bracketed secant step closes the gap in two to four runs, with bisection only if a step leaves the bracket. The figures are exact to the euro.
- **Tests.** `js/tests_goals_and_resources_math.js` (8 cases) and `scripts/check-goals-and-resources.mjs`, which proves the engine against a reference calculator that takes nothing from it: a plain annuity for the mortgage, a year-by-year rebuild for college, the retirement module run back at the engine's answer, the tax engine's difference for relief, and the yearly money handed out by hand. `npm run check:goals-and-resources`. Under a second.
- Not built: the screen, `state.js`/`render.js`/`app.js`/presenter/video wiring, and listing the check in the CI workflows.

### The illustrative household

Spare cash €60,000 (already net of the emergency reserve). €6,000 left over each year (stated). Mortgage €380,000 at 4.0% variable, 18 years from 2026-11-01, both people 45, cleared by 60 (a 15-year term). Niamh: salary €90,000, pot €100,000, 5% personal and 5% employer. Dara: salary €60,000, pot €40,000, 4% and 4%. Household target after tax in today's money, State Pension included: €50,000 from 62, with a later option of €46,000 from 65. Two children aged 10 and 8, four years each from 18, living at home at €5,000 a year each (the central college scenario, 4% education growth). Married, jointly assessed. Goals are taken in the method's order: college, then the mortgage, then retirement.

### The search

For each of the mortgage and the college fund: none, the cash that is left, or the whole amount. Total cash is never more than the €60,000.

- **Whole mortgage** is the lump sum that clears it by 60 without raising today's repayment, found by asking the engine (bisection). **Whole college** is what funding both children today takes.
- **Cash that is left** is what the other goal did not take. The mortgage may take more than the whole amount (the repayment falls below today's); college cannot.
- A part lump sum for college is the same share of each child's cost.
- Two uses count as the same when both lump sums are within €1,000.

### Choosing the four cases

**No single score decides it.** Case 1 keeps the cash as it is, and every goal is pursued from yearly money. (In a plan, the current position is "nothing changes" and belongs to the plan view, not to this module.) The other three are the **most different uses of cash**: the three that, with case 1, are furthest apart in euros moved into the mortgage and into college (the largest smallest gap between any two). They are shown in **order of how much they change from case 1**: euros moved, then goals touched. Nothing about their yearly need or total cost picks them or orders them.

### Two measures, side by side, for every case

| Measure | What it is |
|---|---|
| **Needed this year** | The mortgage's yearly change, plus what is saved yearly for each child, plus the extra pension contribution the search found **after income tax relief**, against the money left over each year. It is also the largest yearly need, because the college saving ends first. |
| **Paid out over the life of the goals** | The mortgage with its lump sum over the whole loan, plus everything paid into the college fund, plus the household's own contributions to retirement (what it pays now and the extra), **after income tax relief**. Employer contributions are not the household's money and are not counted. |

### What it found (illustrative)

Run on merged `main`. Pension money is counted after income tax relief and goals are taken in the planning method's order, so these figures replace the earlier provisional ones. Only the pension change moved them: the order is the same as before.

| | Result |
|---|---|
| Today's repayment | €2,471 a month. Cleared by 60 with no lump sum: €2,811 (+€4,081 a year) |
| Lump sum that clears it by 60 at today's repayment | €45,974 |
| College, both children, funded today | €59,635. Saved yearly from today instead: €6,716 a year |
| Retirement at 62 on €50,000 | Pot needed €1,238,045 against €751,611 projected. Extra paid in: €15,442 a year gross (10.29 points of salary each, inside the relief limit). Income tax relief €6,177, so it costs the household €9,265 a year |
| Retirement at 65 on €46,000 | Pot needed €917,710 against €935,292 projected: on track, nothing extra |

| Case | Cash use | Needed this year | Against €6,000 | Paid out over the life |
|---|---|---|---|---|
| 1 | Cash stays as it is | €20,062 | short €14,062 | €834,168 |
| 2 | €59,635 into the college fund (€365 left) | €13,346 | short €7,346 | €833,847 |
| 3 | €60,000 into the mortgage | €14,736 (after €1,245 freed) | short €8,736 | €814,282 |
| 4 | €45,974 into the mortgage, €14,026 into college | €14,402 | short €8,402 | €818,855 |

Paid out over the life, by goal: mortgage €505,947, €505,947, €486,060 and €490,709; college €59,957, €59,635, €59,957 and €59,881; retirement €268,265 in every case (the household's own contributions after relief, from €447,108 gross).

Goals in the method's order. Case 1: the first child's college covered, the second child's partly covered, the mortgage and retirement not covered. Cases 2, 3 and 4: both children's college and the mortgage covered, retirement partly covered.

The two measures disagree. Case 2 needs the least this year; case 3 pays out €19,565 less over the life of the goals, because €60,000 into the mortgage saves interest at 4% and €59,635 into college grows at 0.13%.

The later option, priced beside every case: needed this year is €10,797, €4,081, €5,471 and €5,137 for cases 1 to 4, and paid out over the life is €666,495, €666,173, €646,608 and €651,181. At 65 on €46,000 retirement needs nothing extra, so cases 2, 3 and 4 are no longer short (€1,919, €529 and €863 to spare); case 1 is still short by €4,797.

## The contract (engine built; screen and wiring not started)

`generated.goalsAndResourcesInputs`. Engine in `js/goals_and_resources_math.js`. `scripts/price-goal-cases.mjs` is a thin caller of it, so there is one implementation.

| Field | Type | Rule |
|---|---|---|
| `spareCash` | number, required | Cash available now, net of the emergency reserve. 0 or more. |
| `leftOverEachYear` | number, required | What is left over each year. **Stated in Stage 1.** In a plan it comes from the Household cash flow result's left-over figure, and this field is replaced by that result. |
| `goalPriorities` | **removed** | Rejected if present: `generated.goalsAndResourcesInputs.goalPriorities is not accepted. Goals are taken in a fixed order: college, then the mortgage, then retirement.` See "Goal order". |
| `mortgage` | object, required | `currentBalance`, `annualInterestRate`, `remainingTermYears`, `startDateIso`, `repaymentType: 'repayment'`, optional `fixedPaymentAmount`, plus `currentAge` and `clearByAge`. |
| `pensions` | array, required | One entry per person: `id`, `title`, `currentAge`, `currentSalary`, `currentPot`, `personalPct`, `employerPct`, `includeStatePension`. Same validation as `pensionInputs.pensions`. |
| `householdTaxStatus` | string | As `pensionInputs`. |
| `retirement` | object, required | `retirementAge`, `targetIncomeToday`. The target is the household's, after tax, in today's money. |
| `laterRetirement` | object, optional | The same two fields. Priced beside every case, not attached to one. |
| `children` | array, required | `id`, `title`, `age`. College timing and cost are the central assumptions; no cost or rate is accepted. |

No growth, inflation, cash or DIRT rate is accepted. Rates are central.

### Goal order

The engine takes goals in the order the planning method uses for a resource ledger, so it decides which goals read covered, partly covered or not covered when money runs out:

1. Protection and the emergency reserve. Outside this module: `spareCash` is already net of the reserve.
2. The goals that come soonest: each child's college, in order of when it starts.
3. The mortgage cleared by its age.
4. Retirement.

The order is fixed in the engine, never taken from the payload, and stated in the assumptions table (see Words). It is the same order the plan's resource ledger uses, so a goal never reads covered in this module and short in the plan.

### Where the mortgage fields come from

Balance, rate and remaining term are already planner facts, so nothing new is asked: `mortgage_current_balance` (`/liabilities/*/currentBalance`), `mortgage_annual_interest_rate` (`/liabilities/*/annualInterestRate`) and `mortgage_remaining_term_months` (`/liabilities/*/remainingTermMonths`). `buildMortgageInput` in `js/planning/adapters/mortgage.js` already maps them: `remainingTermYears` is the months ÷ 12 and `startDateIso` is the plan's calculation date. This module reuses that adapter. What is new is `clearByAge`, which is the goal itself.

### Cases

Not authored in this version. The engine derives four: case 1, the cash kept as it is, then the three most different uses of cash in order of how much they change. The later retirement option is priced beside each.

### What the engine returns

`computeGoalsAndResourcesProjection(rawInputs)` follows the college engine's shape (`assumptionsTable`, `outputsTable`, `tables`, `charts`, `debug`). `debug.cases[]`:

- `id`, `title`, `cashUsed`, `cashLeft`.
- `mortgage`: `lumpSum`, `monthlyPayment`, `todayMonthlyPayment`, `yearlyChange`, `payoffDateIso`, `totalPaidOverTheLoan`.
- `college`: `lumpSumToday`, `yearlyAmountNow`, `paidIn`, and `perChild[]` with `lumpSumToday`, `yearlyAmount`, `savingYears`.
- `pension`: `requiredPotAtToday`, `projectedPotAtToday`, `yearlyExtra` (gross, what goes into the pension), `yearlyExtraTaxRelief`, `yearlyExtraCost` (after relief, what the household pays), `reachedCap`, `gapLeftOver`, `extraOverTheLife`, `headroomYearly`.
- `neededThisYear`, `shortfall`, `spare`. These use `yearlyExtraCost`.
- `paidOutOverLife`: `mortgage`, `college`, `retirement` (the household's own contributions after relief), `total`.
- `states`: per goal, in the method's order (see Goal order), covered, partly covered or not covered.
- `ledger[]`: each year's mortgage change, each child, pension, total, and the difference from what is left over.
- `laterRetirement`: the same measures at the later option.

`debug.uses[]` holds every cash use priced, in order of how much it changes. It is not a ranking.

## Words

Everything on screen is addressed to the household as "you", and is derived from the figures, never typed per case. Plain, sentence case, euro with thousands separators, "a year" never "p.a.".

| Piece | Template |
|---|---|
| Question | Can your money do everything you want? |
| Headline, short | You’re short by €8,402 a year |
| Headline, left over | You have €1,919 a year to spare |
| Support | Your goals need €14,402 a year against the €6,000 you have. With a lower repayment: …, counting the €1,245 a lower repayment frees. |
| Case amount line | €45,974 and €14,026 from your cash. With none: Nothing from your cash. |
| Case titles | Cash stays as it is; Fund college today; All cash into the mortgage; Mortgage, then college |
| Goal rows | Your mortgage cleared by 60; College, first child; College, second child; You retire at 62 on €50,000 a year |
| Panel titles | Your money now; Your money each year; What you have; What your goals need |
| States | Covered, Partly covered, Not covered, always beside their colour |
| Order line (assumptions table) | Your goals are taken in this order: the costs that come soonest, then your mortgage, then retirement. |
| Pension line (assumptions table) | Pension contributions count at what they cost you after income tax relief. Your pension grows on the full amount paid in. |

Never: "we recommend", "you should", "best option", "best", "ideal", "optimal", or the name of any product or provider. The page says what is and what each case would change.

## Undecided

1. **What "current position" means: decided 13 October.** In a plan, the current position is "nothing changes" (today's mortgage, contributions and savings), and the plan view shows it. This module keeps case 1 as built ("cash stays as it is, every goal still pursued from yearly money") and does not call it the current position.
2. **The later retirement option: decided.** It stays priced beside every case and is never attached to one. Each case differs by one thing, the use of cash. Combining a cash use with a later retirement belongs to the plan-level routes, which come later.
3. **The side-by-side picture.** Both measures are built in the engine and not drawn. How "paid out over the life of the goals" sits on the screen without becoming a second headline is a design task, and it waits on the red "short" state, which is not designed.
4. **Where the order comes from: decided 13 October.** From the planning method, fixed in the engine (see Goal order). The profile's `priority` (high, medium, low) does not order these goals.
5. **Left over each year.** Stated and constant (nominal) for every year. In a plan it will be the Household cash flow result's left-over figure; the field name is taken from that module when it lands.
6. **Part lump sums.** College takes an equal share across children; the pension search adds the same points of salary for both people from today. Per-person or per-child choices are not designed.
7. **One-off money on its own.** Doing both goals from cash would need €105,609 against €60,000 now. The screen does not show that shortfall.
8. **Retirement inside "paid out".** The household's own contributions are the same in every case at one target, so they lift the total without separating the cases. They are listed as a component so a screen can leave them out.
9. **Frames: not redrawn yet, by decision.** C1 and C2 are stale against this brief, A, B and the phone frame are not redrawn on engine figures, C2 starts on the wrong case, and nothing has been checked in a browser. All of it waits on the red "short" state.
10. **Figures rerun: done 13 October.** `module/future-cost-fund` is on `main` (PR #55); `main` was merged into this branch and the script rerun with both changes. Rerun it whenever the engines, the central assumptions or the illustrative household change. `main` is not touched from this branch.

## Out of scope

- Real client data. Nothing here reads a client record.
- Stated amounts ("what if I put in €5,000?"), which need states that are not designed.
- Investing the cash. Cash earns the central instant-access rate after DIRT.
- Any consumer routing, voice, planner facts, manifest or playbook entry. Do not edit `docs/prompt-pack/`.
