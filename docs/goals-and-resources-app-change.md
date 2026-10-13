# Goals and resources: can the money do everything they want, and what has to give?

Status: design chosen (option C, "have and need"). Priced through the engines for an **illustrative household, not real figures**, 2026-10-13. The pricing script is built. The module itself (payload, engine entry, screen, wiring) is not started.

## Context

A household has several goals pulling on the same limited money. The question this screen answers is **can the money they have do everything they want, and if not, what has to give?** It is shared at 1920×1080 on a call while the adviser clicks between up to four cases, and re-opened later by the client alone on a laptop or phone, so it has to explain itself.

There are two pictures and they are never put on one scale: **money now** (spare cash, a one-off) and **money each year** (what is left over each year). Each goal can usually be paid either way, and the two ways are alternatives, never added together.

The idea it has to land: **the same household, with the cash used differently, needs a very different amount found each year.**

This is a composition over three engines that already exist or are being built. It has no maths of its own.

| Goal | Engine | How a lump sum changes it |
|---|---|---|
| Mortgage cleared by an age | `js/mortgage_math.js` | `oneOffOverpayment` at month 0, `overpaymentBenefit: 'lowerPayment'`, term set to clear by that age. Yearly change is 12 × (the engine's repayment − today's repayment). It can be negative. |
| College, each child its own dated cost | `js/future_cost_fund_math.js` (branch `module/future-cost-fund`) | `lumpShare` of the cost funded today, the rest saved yearly from today. |
| Retirement on a household target | `js/pension_math.js` | The personal contribution is searched through `computePensionProjection` until `currentGapVsRequired` is 0, capped at the age-related relief limit. |

## Reference frames

Design canvas (private link): https://claude.ai/artifact/9gArzoeM5VZDqnHN5Ld5Fp

| Frame | What it shows |
|---|---|
| `C · Have and need · case 1` (`C1.dc.html`) | 1920×1080, option C, engine-priced, case 1 selected |
| `C2.dc.html` | 1920×1080, option C, second frame. It starts on case 4; case 3 was intended and the edit did not land |
| `A`, `B` and `A on a phone` | Not chosen. Still on the first brief's placeholder figures, not engine-priced |

Things to know before using them:

- C1 embeds the script's output as literals in its own script block, so it is a drawing of the engine's answer, not a reference implementation.
- It has not been opened and checked in a browser. Text fit and label collisions in the "money each year" ledger are unchecked.
- The header carries "Illustrative household, not real figures".
- Where this brief and a frame disagree, the brief wins. Tell me which.

## What is built

`scripts/price-goal-cases.mjs` (`node scripts/price-goal-cases.mjs`, or `--json`). It carries the illustrative household as a constant, prices every way of using the cash through the three engines, and picks the four cases.

**It imports `js/future_cost_fund_math.js`, which is on `module/future-cost-fund`. It does not run on this branch alone until that branch is merged.**

### The illustrative household

Spare cash €60,000 (already net of the emergency reserve). €6,000 left over each year. Mortgage €380,000 at 4.0% variable, 18 years from 2026-11-01, both people 45, cleared by 60 (a 15-year term). Niamh: salary €90,000, pot €180,000, 6% personal and 6% employer. Dara: salary €60,000, pot €90,000, 5% and 5%. Household target after tax in today's money, State Pension included: €45,000 from 62, or €42,000 from 65. Two children aged 10 and 8, four years each from 18, living at home at €5,000 a year each (the central college scenario, 4% education growth).

### The search

For each of the mortgage and the college fund: none, the cash that is left, or the whole amount. Total cash is never more than the €60,000.

- **Whole mortgage** is the lump sum that clears it by 60 without raising today's repayment, found by asking the engine (bisection). **Whole college** is what funding both children today takes.
- **Cash that is left** is what the other goal did not take. The mortgage may take more than the whole amount (the repayment falls below today's); college cannot.
- A part lump sum for college is the same share of each child's cost.
- Two uses count as the same when both lump sums are within €1,000.
- Ranked by **yearly need today** = mortgage change + college saving + pension extra, against the €6,000.

### What it found (illustrative)

| | Result |
|---|---|
| Today's repayment | €2,471 a month. Cleared by 60 with no lump sum: €2,811 (+€4,081 a year) |
| Lump sum that clears it by 60 at today's repayment | €45,974 |
| College, both children, funded today | €59,635. Saved yearly from today instead: €6,716 a year |
| Pensions | On track at both targets. Pot needed €963,529 against €1,143,210 projected at 62; €699,789 against €1,402,792 at 65. Extra a year needed: €0 |

| Case | Cash use | Yearly need | Against €6,000 |
|---|---|---|---|
| 1 | Cash stays as it is | €10,797 | short €4,797 |
| 2 | €59,635 into the college fund | €4,081 | €1,919 to spare |
| 3 | €45,974 into the mortgage, €14,026 into college | €5,137 | €863 to spare |
| 4 | €60,000 into the mortgage, retire at 65 on €42,000 | €5,471 | €529 to spare |

Over the whole life of the two goals the amount paid out is €565,903, €565,582, €550,590 and €546,017 for cases 1 to 4. Ranked by year-0 need the college lump comes first; ranked by what is paid out in total it comes last, because the cash earns 0.13% in the fund and the mortgage costs 4%.

## The contract (proposed, not built)

`generated.goalsAndResourcesInputs`. Engine in `js/goals_and_resources_math.js`, to be the script's logic moved into a function with the same outputs.

| Field | Type | Rule |
|---|---|---|
| `spareCash` | number, required | Cash available now, net of the emergency reserve. 0 or more. |
| `leftOverEachYear` | number, required | What is left each year after everything already paid. 0 or more. |
| `mortgage` | object, required | `currentBalance`, `annualInterestRate`, `startDateIso`, `remainingTermYears` or `endDateIso`, `repaymentType: 'repayment'`, optional `fixedPaymentAmount`, `currentAge`, `clearByAge`. Same validation as `mortgageInputs`. |
| `pensions` | array, required | One entry per person: `id`, `title`, `currentAge`, `currentSalary`, `currentPot`, `personalPct`, `employerPct`, `includeStatePension`. Same validation as `pensionInputs.pensions`. |
| `householdTaxStatus` | string | As `pensionInputs`. |
| `retirement` | object, required | `retirementAge`, `targetIncomeToday`. The target is the household's, after tax. |
| `laterRetirement` | object, optional | The same two fields. Used by the last case. |
| `children` | array, required | `id`, `title`, `age`. College timing and cost are the central assumptions; no cost or rate is accepted. |

No growth, inflation, cash or DIRT rate is accepted. Rates are central.

### Cases

Not authored in this version. The engine derives four: case 1 is the current position (cash stays as it is, every goal paid from yearly money), then the three lowest yearly needs among the distinct cash uses. Case 4 is priced at `laterRetirement` when it is present.

### What the engine returns

`computeGoalsAndResourcesProjection(rawInputs)` follows the college engine's shape (`assumptionsTable`, `outputsTable`, `tables`, `charts`, `debug`). `debug.cases[]`: `id`, `title`, `cashUsed`, `cashLeft`, `mortgage` (`lumpSum`, `monthlyPayment`, `todayMonthlyPayment`, `yearlyChange`, `payoffDateIso`, `totalPaidOverTheLoan`), `college` (`lumpSumToday`, `perChild[]` with `lumpSumToday`, `yearlyAmount`, `savingYears`), `retirement` (`requiredPot`, `projectedPot`, `extraYearly`, `reachedCap`, `gapLeftOver`, `headroomYearly`), `needToday`, `shortfall`, `spare`, `lifetimePaidOut`, `ledger[]` (each year: mortgage change, each child, pension, total, against what is left over), and a state per goal (covered, partly covered, not covered). `debug.ranking[]` holds every cash use priced, and `debug.wholeMortgageLump` and `debug.wholeCollege` the two reference amounts.

Goals take their share of the yearly money in the order the household listed them (college, mortgage, retirement). That order is what makes a goal "partly covered" and is stated on the screen.

## Undecided

1. **What "current position" means.** Built as "cash stays as it is, every goal still pursued from yearly money". The alternative is "nothing changes": an 18-year mortgage, no college fund, today's contributions, which would measure the shortfall against goals the household has not yet started.
2. **Case 4.** Built as instructed: the third-ranked cash use priced at 65 on €42,000. With these inputs pensions are already on track at both targets, so the retirement target moves no yearly shortfall, only the pension surplus. The alternative is the best cash use plus the later target.
3. **The ranking metric.** Year-0 need, as asked. The lifetime amount paid out ranks the cases the other way round. Which one the screen should show, or both, is not decided.
4. **The yearly resource is constant.** €6,000, nominal, for every year. A lower repayment counts as money freed; pension contributions above what the target needs are reported and not counted as money to find.
5. **Payment order.** College, mortgage, retirement, as listed in the first brief. Where that order comes from in a real payload is not decided.
6. **Part lump sums.** College takes an equal share across children; the pension search adds the same points of salary for both people. Per-person or per-child choices are not designed.
7. **One-off money on its own.** Doing both goals from cash would need €105,609 against €60,000 now. The screen does not show that shortfall.
8. **Mortgage inputs.** Balance, rate and term are not planner facts in the consumer lane today. Where they would come from is not decided.
9. **Frames.** Options A and B and the phone frame are not redrawn on engine figures, C2 starts on the wrong case, and nothing has been checked in a browser.
10. **Words and states.** "Partly covered" uses amber and "not covered" red with their words, as in the first brief. Not reviewed against the banned-phrase list beyond authoring.

## Out of scope

- Real client data. Nothing here reads a client record.
- Stated amounts ("what if I put in €5,000?"), which need states that are not designed.
- Investing the cash. Cash earns the central instant-access rate after DIRT.
- Any consumer routing, voice, planner facts, manifest or playbook entry. Do not edit `docs/prompt-pack/`.
