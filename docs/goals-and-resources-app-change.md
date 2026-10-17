# Goals and resources: can the money do everything you want, and what has to give?

Status: design chosen (option C, "have and need"). Priced through the engines for an **illustrative household, not real figures**. The pricing script is built and its figures below are from a run on merged `main` (13 October 2026, after PR #55), with pension money counted after income tax relief and goals taken in the planning method's order. The engine `js/goals_and_resources_math.js` is built and tested and runs in about 0.55 s. The screen and app wiring are built, with case selection, presenter/video support and conditional ledger footnotes.

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

**Approved 14 October 2026:** `C1.dc.html` (case 1), `C2.dc.html` (case 3) and `Phone.dc.html`, redrawn at the engine's figures with the short state. They are the reference for the screen. `A`, `B` and the first phone frame were not chosen and are left on the canvas as they were.

- The short state is as drawn: the part you do not have is a red outline with a light tint, and a solid red square sits beside the word ("Short by" beside the picture, the headline's square beside "You're short by"). Red is never alone. It is the household cash flow screen's treatment.
- The frames embed the engine's output as literals in their own script block, so they are a drawing of an engine answer, not a reference implementation. The screen is built from the engine, not from them.
- **Where this brief and a frame disagree, the brief wins.** One case so far: the first drawing of C1 carried "Niamh and Dara, both 45" in its header. The screen never names the household, and the approved frames have it removed.

## What is built

`scripts/price-goal-cases.mjs` (`node scripts/price-goal-cases.mjs`, or `--json`). It carries the illustrative household as a constant, prices every way of using the cash through the three engines, and picks the four cases.

It imports `js/future_cost_fund_math.js` (on `main` since PR #55) and the tax engine's `computeTaxYear`, which it uses to cost each year's contributions after income tax relief.

### The engine

- `js/goals_and_resources_math.js`: `normalizeGoalsAndResourcesInputs`, `computeGoalsAndResourcesProjection(rawInputs, options)`, `getGoalsAndResourcesCases`, `getDefaultGoalsAndResourcesScenarioId`. Case ids are stable: `cash-stays`, `college-today`, `mortgage-all-cash`, `mortgage-then-college` for the sample household.
- **A helper in the retirement module.** `computePersonalContributionCosts(rawInputs)` in `js/pension_math.js` is additive: what the household's own personal contributions cost each year after income tax relief, from the tax engine. It reuses the module's own item-building (`householdTaxItemsAtYear`, extracted from `buildContributionNetCosts`, so the two describe the same household) and its relief limit. Nothing the retirement module shows has changed. Its two tests are in `js/tests_pension_math.js`.
- **The search reads three fields** of `computePensionProjection(...).debug`: `requiredPot`, `projectedPotCurrent` and `requiredPotDepletionTolerance`, the ones the retirement module's own readiness reads. A test and a runtime guard fail with a clear message if any is ever missing or not a number.
- **The search** (changed 15 October, PRs #67 and #70). The ceiling is the room across the whole schedule: each working year's relievable euro amount (the age band's share of salary up to the €115,000 earnings cap, from the pension engine's own functions) as a share of that year's projected salary, less what is paid in, the largest over the years and then over the people. Past it nothing changes, below it something does. The pot is a straight line in the contribution only while no year's limit binds, so the search runs the ceiling first (if that does not close the gap the limit is reached) and closes in with an Illinois step; the figures are exact to the euro. At the limit with the target out of reach, the four notes beside money invested outside a pension are carried on `pension.disclosures`.
- **Tests.** `js/tests_goals_and_resources_math.js` (22 cases) and `scripts/check-goals-and-resources.mjs`, which proves the engine against a reference calculator that takes nothing from it: a plain annuity for the mortgage, a year-by-year rebuild for college, the retirement module run back at the engine's answer, the tax engine's difference for relief, and the yearly money handed out by hand. `npm run check:goals-and-resources`. About 0.6 s on a laptop. The check prints the time on every run and fails only above 3 seconds, so a slower CI machine does not trip it.
- **The projection is cached by payload** (`projectGoalsAndResources(rawInputs)`, six entries, keyed by both central versions and the payload; any call with options bypasses it). A projection is about half a second and the screen, the paste pipeline and the presenter all ask for the same one. The cached object is shared: read it, do not change it. Tested in `js/tests_goals_and_resources_math.js`.
- App wiring is complete in `state.js`, `module_pipeline.js`, `render.js` and `app.js`, with presenter and video integration. The check runs in consumer CI. Seven wiring cases verify derived figures, import rejection, module switching, presenter cases, selected video figures and relief notes.

### The screen

Built on `module/goals-and-resources-screen`, retargeted to `main` after #75 merged. Shared app wiring is included. Inputs alone determine outputs, case ledgers and charts; pasted figures never override them. Selected cases persist in editable sessions and remain in memory only in read-only sessions.

| File | What it is |
|---|---|
| `js/goals_and_resources_view.js` | Pure. The words, the geometry at every width, where each mark sits, the forbidden-text scan. Nothing in it needs a DOM. |
| `js/goals_and_resources_module.js` | Draws what the view says. The 520 ms clock, `presenterSelectScenario`, `garState()`, `destroyGoalsAndResources()`. Follows `js/future_cost_fund_module.js`; the clock is copied, not shared. |
| `styles/base.css` | Shared `.gar-` rules. The standalone stylesheet has been removed and the preview loads `base.css` alone. |
| `dev/goals-and-resources-preview.html` | The module alone, with `?preset=` (illustrative, one-child, four-children, mortgage-ends, spare, no-cash, no-later, stretched, stretched-rich), `?case=` and `?width=`. |
| `js/tests_goals_and_resources_view.js`, `js/tests_goals_and_resources_module.js` | 20 and 20 cases. Run by `npm run check:goals-and-resources` with the engine suite. |

What was decided building it:

- **Three arrangements, two picture sizes.** The 1920 frame (the table of cases, the two panels, the goals beside the yearly picture) from a container width of 1740; the phone frame's pictures side by side with the goals under them from 760; the phone's single column under that. The pictures are the frame's size or the phone's size, so a resize inside an arrangement never rebuilds the screen. Only the 1920 and 390 frames were drawn; the side-by-side arrangement between them is those two frames' pieces reflowed, not a new design. Say if it should be drawn.
- **The yearly picture has room for its note.** The picture is drawn on a 331 px scale and given 380 px, so that the "freed by a lower repayment" note under the line fits when what you have is the largest figure on the screen.
- **A child is "first", "second", "third" by position.** The payload's child titles never reach a string, so a payload that names a child still produces a screen that does not.
- **A target out of reach at the relief limit says so.** The engine downgrades such a goal from "covered" to "partly" (the money is found, the target is not met). "€18,000 of €18,000 a year" would be nonsense, so the row reads "At the most income tax relief allows, and still short of your target". The brief had no line for this; it is the only new sentence.
- **One source for the words, decided 14 October.** The screen and the presenter show the same strings, so the view builds none of its own: the engine's `words.amountLine`, `words.headline`, `words.support` and `laterRetirement.words` (label, needed line, result) are read as given. `words.amountLine` now carries the frames' wording. `words.state` (`short`, `spare`, `left`) says what the yearly money amounts to.
- **"To spare" only when every goal is covered, decided 14 October.** Money left over with a goal still not met (only possible for retirement at the relief limit) reads "You have €X a year left over", the support line reads "Your retirement target is not met, even at the most income tax relief allows.", and the picture's word is "Left over". The later option's line follows the same rule ("€X left over"). The square for that state is amber, the colour already used for "Partly covered". The brief did not say; change it if it should be another colour.
- **Nothing animates through CSS.** The only motion is the marks travelling between cases, on the module's clock. Opacity of every mark is a function of its painted size, so the settled frame equals a fresh render after any sequence of clicks.
- **Checked in a browser.** Headless Chrome, 312 configurations (nine payload shapes, eight widths from 390 to 1920, every case) with the line boxes of every visible string tested for overlap and for leaving their panel, once in the fallback font and once in a wider one. No collision, nothing leaves its panel, no sideways scroll below 1700.

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

Goals in the method's order, judged year by year (changed 15 October, PR #67). Case 1: the first child's college covered; the second child's partly covered (short in years 0 to 7, covered from 8); the mortgage partly covered (nothing until year 8, covered from 10); retirement partly covered (nothing until year 10, some of it from then and never all of it). Cases 2, 3 and 4: both children's college and the mortgage covered, retirement partly covered. This year's figures (what each goal needs and gets) are unchanged; only the state words and the ledger's length moved.

The two measures disagree. Case 2 needs the least this year; case 3 pays out €19,565 less over the life of the goals, because €60,000 into the mortgage saves interest at 4% and €59,635 into college grows at 0.13%.

The later option, priced beside every case: needed this year is €10,797, €4,081, €5,471 and €5,137 for cases 1 to 4, and paid out over the life is €666,495, €666,173, €646,608 and €651,181. At 65 on €46,000 retirement needs nothing extra, so cases 2, 3 and 4 are no longer short (€1,919, €529 and €863 to spare); case 1 is still short by €4,797.

## The contract (engine, screen and app wiring built)

`generated.goalsAndResourcesInputs`. Engine in `js/goals_and_resources_math.js`. `scripts/price-goal-cases.mjs` is a thin caller of it, so there is one implementation.

| Field | Type | Rule |
|---|---|---|
| `spareCash` | number, required | Cash available now, net of the emergency reserve. 0 or more. |
| `leftOverEachYear` | number, required | What is left over each year. **Stated in Stage 1.** In a plan it comes from the Household cash flow result's left-over figure, and this field is replaced by that result. |
| `goalPriorities` | **removed** | Rejected if present: `generated.goalsAndResourcesInputs.goalPriorities is not accepted. Goals are taken in a fixed order: college, then the mortgage, then retirement.` See "Goal order". |
| `mortgage` | object, required | `currentBalance`, `annualInterestRate`, `remainingTermYears`, `startDateIso`, `repaymentType: 'repayment'`, optional `fixedPaymentAmount`, plus `currentAge` and `clearByAge`. `clearByAge` is rejected only at or below `currentAge`. If the mortgage already ends by that age the goal is covered with nothing needed (see Cases). |
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

If the mortgage already ends by `clearByAge`, the goal is covered with nothing needed: no lump sum and no yearly change. The uses of cash that would have gone into the mortgage collapse into the others, so fewer than four cases is expected, and the screen says "Your mortgage already ends by {age}."

### What the engine returns

`computeGoalsAndResourcesProjection(rawInputs)` follows the college engine's shape (`assumptionsTable`, `outputsTable`, `tables`, `charts`, `debug`). `debug.cases[]`:

- `id`, `title`, `cashUsed`, `cashLeft`.
- `mortgage`: `lumpSum`, `monthlyPayment`, `todayMonthlyPayment`, `yearlyChange`, `payoffDateIso`, `totalPaidOverTheLoan`.
- `college`: `lumpSumToday`, `yearlyAmountNow`, `paidIn`, and `perChild[]` with `lumpSumToday`, `yearlyAmount`, `savingYears`.
- `pension`: `requiredPotAtToday`, `projectedPotAtToday`, `yearlyExtra` (gross, what goes into the pension), `yearlyExtraTaxRelief`, `yearlyExtraCost` (after relief, what the household pays), `reachedCap`, `gapLeftOver`, `extraOverTheLife`, `headroomYearly`.
- `neededThisYear`, `shortfall`, `spare`. These use `yearlyExtraCost`.
- `paidOutOverLife`: `mortgage`, `college`, `retirement` (the household's own contributions after relief), `total`.
- `states`: per goal, in the method's order (see Goal order). `need` and `covered` are this year's. `state` is judged from the ledger: covered if met in every year it needs money, not covered if never met, partly covered otherwise. `firstShortYear` is the first year (0 is this year) it is not fully met, or `null`.
- `ledger[]`: each year's mortgage change, each child, pension, total, and the difference from what is left over. It runs to the last year any goal is active (the mortgage's term, each child's college start, retirement and the later option's retirement), 20 rows for the sample, and carries nothing for the mortgage once it is cleared.
- `laterRetirement`: the same measures at the later option.

`debug.uses[]` holds every cash use priced, in order of how much it changes. It is not a ranking.

## Words

Everything on screen is addressed to the household as "you", and is derived from the figures, never typed per case. Plain, sentence case, euro with thousands separators, "a year" never "p.a.".

| Piece | Template |
|---|---|
| Question | Can your money do everything you want? |
| Headline, short | You’re short by €8,402 a year |
| Headline, money left over and every goal covered | You have €1,919 a year to spare |
| Headline, money left over and a goal not met | You have €1,203 a year left over. Only possible for retirement at the income tax relief limit. |
| Support | Your goals need €14,402 a year against the €6,000 you have. With a lower repayment: …, counting the €1,245 a lower repayment frees. When money is left over and a goal is still not met **because the target is out of reach at the relief limit** (`reachedCap`, and only then): Your retirement target is not met, even at the most income tax relief allows. When money is left over and a goal is short in a later year, the ordinary line above, until its wording is settled (see Undecided). |
| Case amount line | Nothing from your cash; €59,635 into the college fund; €60,000 into the mortgage; €45,974, then €14,026 (in the order the cash is taken: the mortgage first, the college first only where it is filled first). One source: `words.amountLine`, read by the screen and by the presenter's case list. |
| Beside the yearly picture | Short by, To spare (every goal covered) or Left over (a goal not met), then the amount and "a year", with a square beside the word: red, green or amber |
| Quiet figures | Paid out over the life of your goals; If you retire at 65 on €46,000, then "€5,471 needed this year" and "still short by €4,797", "€529 to spare" (every goal covered) or "€529 left over" (a goal not met). One source: `laterRetirement.words`. |
| Goal detail | Paid today with €28,689; After €6,748 today; €2,397 of €3,113 a year; Repayment rises to / falls to / stays at €2,811 a month; after income tax relief; At the most income tax relief allows, and still short of your target. (approved 14 October) |
| Children | First child, Second child, Third child, Fourth child, by position, whatever the payload calls them |
| Case titles | Cash stays as it is; Fund college today; All cash into the mortgage; Mortgage, then college |
| Goal rows | Your mortgage cleared by 60; College, first child; College, second child; You retire at 62 on €50,000 a year |
| Panel titles | Your money now; Your money each year; What you have; What your goals need |
| States | Covered, Partly covered, Not covered, always beside their colour |
| Mortgage that already ends | Your mortgage already ends by 60. |
| Order line (assumptions table) | Your goals are taken in this order: the costs that come soonest, then your mortgage, then retirement. |
| Pension line (assumptions table) | Pension contributions count at what they cost you after income tax relief. Your pension grows on the full amount paid in. |

Never: "we recommend", "you should", "best option", "best", "ideal", "optimal", or the name of any product or provider. The page says what is and what each case would change.

## Undecided

1. **What "current position" means: decided 13 October.** In a plan, the current position is "nothing changes" (today's mortgage, contributions and savings), and the plan view shows it. This module keeps case 1 as built ("cash stays as it is, every goal still pursued from yearly money") and does not call it the current position.
2. **The later retirement option: decided.** It stays priced beside every case and is never attached to one. Each case differs by one thing, the use of cash. Combining a cash use with a later retirement belongs to the plan-level routes, which come later.
3. **The side-by-side picture: decided and drawn.** "Needed this year" is the headline figure of each case. "Paid out over the life of your goals" is a quieter second figure beneath it in the same case, never on the same scale and never added to it.
4. **Where the order comes from: decided 13 October.** From the planning method, fixed in the engine (see Goal order). The profile's `priority` (high, medium, low) does not order these goals.
5. **Left over each year.** Stated and constant (nominal) for every year. In a plan it will be the Household cash flow result's left-over figure; the field name is taken from that module when it lands.
6. **Part lump sums.** College takes an equal share across children; the pension search adds the same points of salary for both people from today. Per-person or per-child choices are not designed.
7. **One-off money on its own.** Doing both goals from cash would need €105,609 against €60,000 now. The screen does not show that shortfall.
8. **Retirement inside "paid out".** The household's own contributions are the same in every case at one target, so they lift the total without separating the cases. They are listed as a component so a screen can leave them out.
9. **Frames: redrawn and approved 14 October.** C1 (case 1), C2 (case 3) and Phone, with the short state. See Reference frames.
10. **Figures rerun: done 13 October.** `module/future-cost-fund` is on `main` (PR #55); `main` was merged into this branch and the script rerun with both changes. Rerun it whenever the engines, the central assumptions or the illustrative household change. `main` is not touched from this branch.

11. **Proposal A, approved 16 October.** The three state words stay Covered, Partly covered and Not covered. The detail carries the timeline, in calendar years: “Nothing this year. Covered from 2036.”; “Nothing this year. Some of it from 2036, never all of it.”; “Covered this year. Short from 2027, covered again from 2034.”; “Covered this year. Short from 2032.” when there is no later recovery; and “€2,397 of €3,113 a year. Covered from 2034.” A goal partly funded this year and never fully funded keeps its existing “€X of €Y a year” line. These dates come from the ledger; the examples do not override its result. The engine fields `firstMoneyYear`, `coveredFromYear` and `firstShortYear` remain offsets, and the view adds `debug.calculationYear`. Ledger tables use the same calendar-year base.

12. **Future shortfall support.** When this year has money left over but later goals are short, append “From 2027, your goals need more than you have left over.” to the ordinary support line. When retirement alone is the first goal to become short, use “From 2027, your retirement saving costs more than you have left over.” The engine owns this string so the screen and presenter agree. The later option's result line is unchanged.

13. **Relief-limit disclosures remain deferred.** Their agreed location is the footnote under the ledger, only at the limit. This wording change does not render them; the existing retirement row and support sentence still say when the target is out of reach at the limit.

## Out of scope

- Real client data. Nothing here reads a client record.
- Stated amounts ("what if I put in €5,000?"), which need states that are not designed.
- Investing the cash. Cash earns the central instant-access rate after DIRT.
- Any consumer routing, voice, planner facts, manifest or playbook entry. Do not edit `docs/prompt-pack/`.


### Ledger relief notes and app verification

The relief-limit disclosures are rendered from the central tax catalogue immediately below each affected case’s calendar-year ledger. They appear only when the pension search reaches the relief limit with a target still unmet; ordinary cases have no extra footnote. The video follows the selected case’s screen figures and ledger.

Real-app Chrome checks cover all four cases at 320, 390 and 1440px, saved-case reopening, read-only selection without session writes, and footnotes below capped-case ledgers only. The dedicated check covers engine, view, module and wiring; video scene, video brief and build checks also run before review.
