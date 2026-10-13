# Property decisions: keep or sell a rental, and trade down the home

App change brief for Claude Code. Paste this whole file as the prompt. Suggested repo path: `docs/property-decisions-app-change.md`.

Status: designs chosen (A1 "cut down" and B1 "two blocks"), not started. Written 13 October 2026.

## Context

Two modules, built one after the other in this change. Each is complete without the other.

| | Rental: keep or sell | Home: trade down |
|---|---|---|
| The one question | What does this property give us each year if we keep it, and what would we have in hand if we sold it? | If we set a yearly repayment we are comfortable with, what home does that buy? |
| Cases | Two, fixed: Keep and Sell | One to four: stay, or move at a stated yearly repayment |
| The idea it has to land | A headline price shrinking to what actually reaches us, set against a yearly figure that is smaller than the rent suggests | The trade between yearly breathing room and the size of the home, with the money freed each year shown beside the home budget |
| The picture (one element carries the screen) | One bar, cut down step by step from the headline to what is left | A home budget built from two blocks, released money and a loan, where the loan block changes by case |

They are two modules because a rental's net income and the cash freed by downsizing a home are different questions with different inputs. A "trade down a rental" module would put a rental-yield assumption in charge of the answer, so it is not in this change (see Out of scope). Do not join the two, and do not share state between them.

Nothing in the app answers either question today. They do not overlap `house_purchase` (buying with savings) or `mortgage_analysis` (changing an existing mortgage).

Reference frames, in the design canvas (private link: https://claude.ai/artifact/E51jWyHBiprkbuWUuAreb7):

| Frame | File | What it shows |
|---|---|---|
| `A1 · Keep selected` | `Main.dc.html` | 1920×1080, Keep |
| `A1 · Sell selected` | `A1-sell.dc.html` | 1920×1080, Sell |
| `A1 · phone width` | `A1-phone.dc.html` | 390×860, Keep |
| `B1 · Stay selected` | `B1.dc.html` | 1920×1080, Stay |
| `B1 · Repay 18,000 a year selected` | `B1-repay-18.dc.html` | 1920×1080, case 2 |
| `B1 · phone width` | `B1-phone.dc.html` | 390×860, Stay |

The canvas also holds options A2, A3, B2 and B3. They were not chosen. Do not build them.

The frames carry the exact geometry and copy and were drawn from the same arithmetic as this brief, but they have not been opened and checked in a browser, so treat them as a drawing, not a reference implementation. Where this brief and a frame disagree, the brief wins, and tell me which.

Use each module two ways at once. It is shared at 1920×1080 on a call while the adviser clicks between cases, and it is re-opened later by the client alone on a laptop or phone with nobody talking. Nothing may depend on spoken context.

## Decisions I need to make

Code can start without these. Each has a default that is used if I do not answer.

1. **Names and keys.** Module ids `rental_keep_or_sell` and `home_trade_down`. Payload keys `generated.rentalKeepOrSellInputs` and `generated.homeTradeDownInputs`. Files `js/rental_keep_or_sell_math.js`, `js/rental_keep_or_sell_module.js`, `js/home_trade_down_math.js`, `js/home_trade_down_module.js`, each with a `js/tests_*_math.js`.
2. **Selling costs.** The sample states that selling releases 355,000, not what the costs are. The payload therefore carries `sellingCosts`, and the sample's value is 15,000 (650,000 less 280,000 less 355,000). If you would rather the payload carry the released amount directly, say so. The model is otherwise identical.
3. **New-loan terms.** There is no central mortgage rate or term in `PLANEIR_ASSUMPTIONS` (the house purchase adapter has an illustrative default of its own, which is not a central assumption). So `newLoanTermYears` and `newLoanAnnualRate` are **required inputs with no default**. The sample uses 15 years at 4%. They are named in the footnote, read from the model, never typed. Adding a central, versioned entry is a separate decision of the kind the future cost fund brief describes.
4. **Rounding.** Rental: every amount is shown as stated, to the euro. Home: the new loan is rounded to the nearest €1,000 and the home budget shown is the sum of the two blocks as shown, so the bar always adds up. At the sample this reproduces 203,000, 135,000, 546,000 and 478,000 (unrounded they are 202,788, 135,192, 545,788 and 478,192). The footnote says so.
5. **Voice.** The two questions are in "we", so the sentences follow them ("what we would have in hand"). The future cost fund module speaks to "you". Default: keep "we" in these two modules. Tell me if the app should be consistent.
6. **Release surface.** Adviser-only through the Dev Panel and presenter, `consumer: false`. No consumer routing, no voice, no planner facts in this change.

## Before you write code

- Pull `main` and create a new branch, for example `property-decisions`.
- Read `js/repayment_case_module.js` end to end. It is the closest precedent and both modules should feel like its siblings: same clock, same settling discipline, same `build...Module({ rawInputs, selectedCaseId, onSelectCase })` shape, same standalone dev preview (`dev/repayment-module-preview.html`). Then read the commit message of `1d0e895` for the acceptance rule on motion.
- Read `js/mortgage_math.js`: `computeMonthlyPayment(principal, annualInterestRate, monthCount)` (rate is a decimal, months an integer), `getMortgageScenarioCases`, `baseScenarioId` and the scenario error strings.
- Read `js/scenario_cap.js`, the mortgage case-selection wiring in `js/app.js` (`setMortgageScenarioForModule`, `window.__setMortgageScenario`), `js/state.js` (`normalizeGenerated`, `normalizeModuleUi`, `mortgageScenarioId`) and `js/render.js` (`buildMortgageScenarioShell`).
- Read `js/presenter_catalogue.js` (`moduleKind`, `scenarios`), `js/video_scene.js` (`getVideoModuleKind`) and `js/codex_video_brief.js`, because a module the presenter cannot select a case in, or the video cannot describe, is half a module.
- `docs/future-cost-fund-app-change.md` is a sibling brief for a module that is not built yet. It has the same family, the same shell and the same wiring list. If it lands first, follow what it did. If it does not, do not wait for it, and **do not build a shared shell for the three modules in this change**. Resist the refactor. Tell me if a third module makes it worth extracting.
- Then give me a short plan: final field names, the file list, how the selected case is persisted, and where the pure layout functions sit. **Wait for my go-ahead before implementing.**

## Part 1: what both modules share

### The shell

Identical in both, and drawn in every frame. Reference sizes are the 1920 frame.

| Thing | Rule |
|---|---|
| Heading | The question, verbatim, not configurable in Stage 1. 42/52 at 600. Wraps to two lines. |
| Case buttons | One row, 20px apart, 88 tall, radius 8, 2px border. Selected: fill `#16222b`, 2px `--electric-blue` border, name at 800, `aria-pressed`. Unselected: `--bg-1` fill, 14% text border. Each shows the case title and a derived answer line. |
| Sentence | The answer for the selected case, at the top of the stage. 28/38 at 500. Up to two lines. |
| Stage | `--bg-1`, radius 12, one element inside it carries the screen. |
| Footnote | 20px muted, under the stage. |

### Type and colour

Reuse the existing tokens in `styles/base.css` (`--bg-0`, `--bg-1`, `--text`, `--muted`, `--electric-blue`, `--accent-green`, `--accent-amber`, `--accent-red`). Manrope. Tabular figures on every amount (`font-variant-numeric: tabular-nums`). Radius 12 on surfaces, 8 on controls. New styles go in `styles/base.css` under `.rks-` (rental) and `.htd-` (trade down).

- Blue marks the headline mark and the selected case. Green means money left over or a covered goal and always sits beside a word ("in hand", "left over", "freed"). Red means short and always sits beside "short". Amber is **not used in Stage 1**, because "tight" needs a threshold I have not decided (see Out of scope).
- Text is always in text colours, never the series colour.

### Motion

The same rule as the repayment module, from `1d0e895`. Do not use CSS transitions as the clock.

- One clock per module: 520ms (`CLICK_MS`), ease-out cubic. Progress clamped and timed from the first frame, a monotonic token so a stale frame cannot repaint a case the client has left, and a settle timer that is never conditional, because a starved tab never delivers its animation frames.
- The marks move from what is displayed to the target: bars, blocks and the labels that follow them. Nothing else moves.
- All text changes in the same frame as the click: the sentence, the labels, the row names, the button states. Do not count figures up.
- A click while travelling starts from what is currently displayed.
- `prefers-reduced-motion: reduce` means no travel: the new case is drawn at once.
- Do not rebuild the subtree on a click. The elements the client is watching stay put. The row and block structure is the same in every case so that every mark has an old and a new value.

### Words

Plain, sentence case, euro with thousands separators ("€18,000"), "a year" never "p.a.". Minus is the true minus sign `−`. It shows what is and what each case would change, nothing else.

Never: "we recommend", "you should", "best option", "best", "ideal", "optimal", or the name of any product or provider. Test it.

### Accessibility

- Case buttons are real `<button>`s in a group with an accessible name, with `aria-pressed`.
- The picture is `role="img"` with an `aria-label` that is the sentence plus one sentence on the shape. The visible labels are not read twice.
- Touch targets at least 44px. Contrast at least 4.5:1 for text, 3:1 at 24px and above.
- Colour never carries meaning alone.

### Narrow layout

The frames are fixed pixel layouts. In the app the stage is fluid, and bars and blocks are percentages of the plot width so they scale.

- 1200 wide and up: the 1920 layout.
- Under 1200: the phone arrangement, in a container capped at 720 wide and centred. The frames draw only 1920 and 390, so check 1366×768, 1024 and 768 by eye and tell me what looks wrong rather than guessing.

## Part 2: Rental, keep or sell

### The contract

Add `generated.rentalKeepOrSellInputs`. Engine in `js/rental_keep_or_sell_math.js`, renderer in `js/rental_keep_or_sell_module.js`, tests in `js/tests_rental_keep_or_sell_math.js`.

All figures are **stated inputs**. Nothing is estimated and no tax is calculated here. The tax figures are as given.

| Field | Type | Rule |
|---|---|---|
| `rentPerYear` | number, required | Greater than 0. Rent received in a year. |
| `loanRepaymentsPerYear` | number, required | 0 or more. Paid on the loan in a year, capital and interest together. |
| `runningCostsPerYear` | number, required | 0 or more. |
| `taxOnRentalProfitPerYear` | number, required | 0 or more. As stated. |
| `salePrice` | number, required | Greater than 0. |
| `sellingCosts` | number, required | 0 or more. |
| `loanBalance` | number, required | 0 or more. Repaid from the sale. |
| `taxOnGain` | number, required | 0 or more. As stated. |
| `baseScenarioId` | `'keep'` or `'sell'`, optional | Default `'keep'`. |

There is no `scenarios` array. The two cases are fixed, with ids `keep` and `sell`, titles `Keep` and `Sell`.

Sample (the Dev Panel example):

```json
{
  "rentPerYear": 18000,
  "loanRepaymentsPerYear": 13000,
  "runningCostsPerYear": 2500,
  "taxOnRentalProfitPerYear": 3700,
  "salePrice": 320000,
  "sellingCosts": 6000,
  "loanBalance": 180000,
  "taxOnGain": 21000
}
```

### The model

Both cases have the same shape: a start, three cuts, a result. Five rows, always.

| Row | Keep | Sell |
|---|---|---|
| `start` | Rent | Sale price |
| `cut1` | Loan repayments | Selling costs |
| `cut2` | Running costs | Loan repaid |
| `cut3` | Tax on the rental profit | Tax on the gain |
| `result` | Net each year | In hand |

- `run` starts at the start amount. Each cut spans `[run − v, run]` and then `run −= v`. The result is the final `run` and may be negative. Its bar spans `[min(0, result), max(0, result)]`.
- Net each year = rent − loan repayments − running costs − tax on the rental profit.
- In hand = sale price − selling costs − loan balance − tax on the gain.
- The engine asserts `result` equals the sum of the start and the cuts to within €0.01.

### Outputs

`computeRentalKeepOrSellProjection(rawInputs)` follows the college engine's shape: `assumptionsTable`, `outputsTable` (one row per case), `tables`, `charts`, `debug`.

- `debug.cases[]`: `id`, `title`, `rows[]` of `{ key, name, amount, lo, hi }`, `result`, `resultTone` (`'left_over'`, `'level'` or `'short'`).
- `assumptionsTable` states: every figure is as stated for this property; the tax figures are not calculated here; yearly figures are for one year.
- `charts` carries **one** ordinary chart (the base case's five rows) for surfaces with no module to draw for them, chiefly the video summary. The focused pane shows no charts card.
- `getRentalKeepOrSellCases(rawInputs)` returns `[{ id, title, description }]` for the presenter.

### Validation

Messages follow the existing style and name the field.

- `generated.rentalKeepOrSellInputs.rentPerYear must be a number greater than 0.`
- `generated.rentalKeepOrSellInputs.taxOnGain must be a number greater than or equal to 0.`
- Also: a non-finite number, a missing required field, `baseScenarioId` not `keep` or `sell`, an unknown key.
- `rentalKeepOrSellInputs` is mutually exclusive with the other engine keys in `normalizeGenerated`, handled exactly as `collegeFundingInputs` is, and is cleared by a `videoSummary`.

### On screen (A1, "cut down")

In reading order: the question, the two case buttons, the sentence, the chart, the footnote.

Case buttons: the title and a derived answer line, `−€1,200 a year` for Keep and `€113,000 in hand` for Sell. These show **both** answers at once, so a client reading alone sees both without clicking.

#### The chart

Five rows, one per `rows[]` entry. Build the **layout as a pure function** (`layoutRentalChart(model, width)` returning plain numbers and boxes) and keep DOM out of it, so geometry can be tested in Node.

| Thing | Rule | Reference value |
|---|---|---|
| Row pitch | Bars 52 tall, radius 4, 40px between | 92 |
| Name column | Left, fixed width. Start and result at 700 in text colour, cuts at 500 muted | 372 wide, 25px |
| Plot | To the right of the names | starts at 380, 1252 wide |
| Scale | One scale per case, starting at zero. `deepest = max(0, −result)`, `total = start + deepest`, `unit = 70% / total`. The zero line is at `8% + deepest × unit`, so the start bar always ends at 78% of the plot | zero at 8% (Sell), 12.4% (Keep) |
| Start bar | `--electric-blue` | |
| Cut bars | Text colour at 28% | |
| Result bar | Green when 0 or more, red when under 0. A negative result runs left from zero | |
| Zero line | 1px, 45% text, full height, "0" beneath it at 20px muted | |
| Headline line | 1px dashed, 30% text, down from the start bar's right end | |
| Connectors | 1px, 35% text, 40px long, at the lower end of each cut, joining that row to the next | |
| Labels | 16px right of the bar's right end (a negative result: 16px right of zero). Value 36/700, word 22/500 muted, 12px between | |

The Keep frame draws zero at 8%. The rule above gives 12.4% for the sample and is the one to follow, because it is what keeps a deeper negative inside the plot.

A cut of 0 keeps its row, drawn as a 2px mark and labelled `€0`. Rows are never removed, so the structure and the transition are the same every time.

#### Labels and words

Values: start `€18,000`; cut `−€13,000`; result `€113,000` or `−€1,200`.

Result word, beside the value:

| Case | Result | Word |
|---|---|---|
| Keep | under 0 | `a year, short` |
| Keep | over 0 | `a year, left over` |
| Keep | 0 | `a year, nothing left over` |
| Sell | 0 or more | `in hand` |
| Sell | under 0 | `short` |

Sentence, derived:

| Case | Sentence |
|---|---|
| Keep, short | `The rent does not cover the loan repayments, running costs and tax: €1,200 short each year.` |
| Keep, left over | `The rent covers the loan repayments, running costs and tax, with €1,200 left over each year.` |
| Keep, level | `The rent exactly covers the loan repayments, running costs and tax.` |
| Sell | `Selling costs, the loan and tax come off the price: €113,000 is what we would have in hand.` |
| Sell, nothing | `Selling costs, the loan and tax take the whole price: nothing would be in hand.` |
| Sell, short | `Selling costs, the loan and tax come to more than the price: €4,000 short.` |

Footnote: `Education only. Figures are as stated for this property; tax is not calculated here. This shows what is, and what each case would change.` The frames carry only the last sentence. The middle one is the one addition, because a figure that looks calculated and is not should say so.

#### Narrow (`A1 · phone width`)

Same five rows, different constants:

- Heading 20/26. Buttons 175×64 side by side, name 18/700, answer 14/500 muted. Sentence 16/23.
- The chart sits on a full-width `--bg-1` surface, radius 12. Rows 84 pitch. The **name sits above its bar** (16px, same weights), the bar is 30 tall, the label 10px right of the bar's end with the value at 19/700 and the word at 14/500.
- `unit = 62% / total`, zero at `6% + deepest × unit`, so the start bar ends at 68%.
- No connectors. The dashed headline line and the zero line stay. Footnote 13/18.

## Part 3: Home, trade down

### The contract

Add `generated.homeTradeDownInputs`. Engine in `js/home_trade_down_math.js`, renderer in `js/home_trade_down_module.js`, tests in `js/tests_home_trade_down_math.js`.

| Field | Type | Rule |
|---|---|---|
| `homeValue` | number, required | Greater than 0. |
| `mortgageBalance` | number, required | Greater than 0. |
| `currentAnnualRepayments` | number, required | Greater than 0. What is repaid on the mortgage in a year today. |
| `sellingCosts` | number, required | 0 or more. `homeValue − mortgageBalance − sellingCosts` must be 0 or more. |
| `buyingCosts` | number, required | 0 or more. Must not exceed the released amount. |
| `newLoanTermYears` | integer, required | 1 to 40. No default (decision 3). |
| `newLoanAnnualRate` | number, required | 0 to 0.15, a decimal. No default. |
| `baseScenarioId` | string, optional | Must match a case id when present. Default is the first case. |
| `scenarios` | array, required | 1 to `MAX_MODULE_SCENARIO_CASES` (4), from `js/scenario_cap.js`. |

Each case:

| Field | Type | Rule |
|---|---|---|
| `id` | string, required | Unique. Stable, because the presenter selects cases by id. |
| `kind` | `'stay'` or `'move'`, required | |
| `title` | string, optional | Absent: derived (see Words). |
| `description` | string, optional | One sentence. |
| `annualRepayment` | number, required when `kind` is `'move'` | 0 or more, and no more than `currentAnnualRepayments`. 0 means no mortgage. Ignored for `'stay'`. |

A case states **how much is repaid**, never how big the home is. The engine solves the loan and the budget.

Sample (the Dev Panel example, four cases exactly):

```json
{
  "homeValue": 650000,
  "mortgageBalance": 280000,
  "currentAnnualRepayments": 30000,
  "sellingCosts": 15000,
  "buyingCosts": 12000,
  "newLoanTermYears": 15,
  "newLoanAnnualRate": 0.04,
  "baseScenarioId": "stay",
  "scenarios": [
    { "id": "stay", "kind": "stay" },
    { "id": "repay-18000", "kind": "move", "annualRepayment": 18000 },
    { "id": "repay-12000", "kind": "move", "annualRepayment": 12000 },
    { "id": "no-mortgage", "kind": "move", "annualRepayment": 0 }
  ]
}
```

### The model

- `released = homeValue − mortgageBalance − sellingCosts`. Sample: 355,000.
- `cashTowardHome = released − buyingCosts`. Sample: 343,000. This is also the no-mortgage budget.
- **Stay**: block 1 = `homeValue − mortgageBalance` (370,000), block 2 = `mortgageBalance` (280,000), budget = `homeValue`, repaid = `currentAnnualRepayments`, freed = 0.
- **Move at repayment R**: monthly payment `R / 12`, `n = newLoanTermYears × 12`, `i = newLoanAnnualRate / 12`. Loan = `(R/12) × (1 − (1 + i)^−n) / i`, or `(R/12) × n` when the rate is 0, and 0 when R is 0. Budget = `cashTowardHome + loan`. Freed = `currentAnnualRepayments − R`.
- Payments are monthly, compounded monthly. This is what reproduces the sample. Annual compounding gives 200,131 and 133,421 and does not.
- The loan is the inverse of `computeMonthlyPayment` in `js/mortgage_math.js`. Call that function to check the round trip, and do not change it.
- **Scale never changes on a click.** The bar's scale is `homeValue`, always, so the same pixel width means the same euros in every case.

### Rounding

The new loan is rounded to the nearest €1,000 for display (decision 4). The home budget shown is block 1 as shown plus the loan as shown. Money stated in the payload and the freed amounts are exact.

### Outputs

`computeHomeTradeDownProjection(rawInputs)`: `assumptionsTable`, `outputsTable` (one row per case), `tables`, `charts`, `debug`.

- `debug.cases[]`: `id`, `title`, `description`, `kind`, `annualRepayment`, `block1`, `block2`, `loanUnrounded`, `homeBudget`, `repaid`, `freed`.
- `debug.assumptionsUsed`: the term and rate actually used and where they came from (the payload).
- `charts` carries one ordinary chart (home budget by case) for the video summary.
- `getHomeTradeDownCases(rawInputs)` returns `[{ id, title, description }]` for the presenter.

### Validation

- `generated.homeTradeDownInputs.scenarios supports at most 4 cases; received 5.`
- `generated.homeTradeDownInputs.scenarios[1] (Repay €18,000 a year): annualRepayment must be a number from 0 up to currentAnnualRepayments.`
- `generated.homeTradeDownInputs.sellingCosts: selling would not clear the mortgage.`
- `generated.homeTradeDownInputs.scenarios[2] (Repay €12,000 a year): the home budget is more than the current home. This module shows trading down.`
- Also: duplicate id, unknown case key, `baseScenarioId` not matching, `buyingCosts` more than the released amount, a rate or term out of range, a non-integer term.
- The session importer in `js/state.js` treats `scenarios` like the other capped arrays: tolerate on the way in, cap with an import warning, never throw.
- `homeTradeDownInputs` is mutually exclusive with the other engine keys and is cleared by a `videoSummary`, as above.

### On screen (B1, "two blocks")

In reading order: the question, the case buttons, the sentence, the picture, the footnote.

Case buttons: up to four, 405×88, name 27/700 and a derived line at 22/500 muted: `Home €650,000` for a stay, `Home budget €546,000` for a move. One case: no buttons.

#### The picture

Two things on the stage, a hairline apart. Build the layout as a pure function (`layoutTradeDownChart(model, width)`).

**Left, the home.**

| Thing | Rule | Reference value |
|---|---|---|
| Home figure | Top left. Number 72/700, then the word at 26/500 muted: `home budget`, or `home worth` for a stay | |
| Scale | `homeValue` maps to the whole bar width | 940 |
| Bar | Two blocks, left to right, 120 tall, radius 4 on the outer ends | |
| Block 1 | Solid `--electric-blue`. Stay: the share of the home. Move: cash from selling after buying costs | 343,000 → 496 |
| Block 2 | `--electric-blue` at 28% fill with a 2px inset blue ring. Stay: the mortgage. Move: the new loan. Zero width when the loan is 0 | 203,000 → 294 |
| Today's home | A 1px dashed line at the bar scale's end, and the label beside it: "Today's home" 22 muted over the amount at 30/700 | |
| Block labels | Under each block, left-aligned to its left edge: amount 36/700, name 24 muted, and for block 1 a note at 22 muted | |

**Right, the year.** 380 wide, a 1px hairline (14% text) to its left.

| Thing | Rule |
|---|---|
| Freed figure | 72/700, then "freed each year" 26 muted |
| Track | 380 × 36, radius 4, 8% text fill. Its full length is `currentAnnualRepayments`. The still-repaid part from the left at 26% text, the freed part after it in green |
| Rows | "Still repaid" and "Freed", 24 muted with the amount at 28/700, right-aligned |
| Note | "The full track is today's €30,000 a year." 22 muted |

The home and the year are on **different scales and are labelled as such**. The track's note says what its full length is. Do not align them or draw one on the other's scale.

#### Labels and words

Block 1 name and note:

| Case | Amount | Name | Note |
|---|---|---|---|
| Stay | `€370,000` | `Your share of the home` | `€650,000 less the €280,000 mortgage` |
| Move | `€343,000` | `From selling, after buying costs` | `€355,000 released, less €12,000 buying costs` |

Block 2: `€280,000` `Mortgage` (stay); `€203,000` `New loan`; `€0` `No new loan`.

Case title, derived when none is given: `Stay`; `Repay €18,000 a year`; `No mortgage`. The frames omit the euro sign in button titles. Include it.

Sentence, derived:

| Case | Sentence |
|---|---|
| Stay | `Staying keeps the home at €650,000, with €30,000 a year going on the mortgage.` |
| Move, with a loan | `Repaying €18,000 a year supports a loan of €203,000: a home budget of €546,000, with €12,000 a year freed.` |
| Move, no mortgage | `With no mortgage the home budget is €343,000, and all €30,000 a year is freed.` |

Freed rows: an amount reads `€12,000 a year`. Zero reads `Nothing`.

Footnote: `Education only. New loans run 15 years at 4%, and buying costs are €12,000. Loans are rounded to the nearest €1,000. This shows what each case would change.` The term, rate and costs are read from the model, never typed.

#### Narrow (`B1 · phone width`)

- Heading 20/26. Case buttons 2×2, 175×56, name 15/18 at 700, allowed to wrap. Sentence 16/23.
- The picture sits on a full-width `--bg-1` surface, radius 12. Home figure 44/700 and word 16 muted. The bar is 358 wide, 52 tall. "Today's home €650,000" at 14/18 muted, right-aligned above the bar's end, with the dashed line at the bar's right edge.
- Block labels under the bar: amount 20/700, name 14/18 muted. Block 1's note (13/17 muted) moves to one full-width line under both labels.
- A hairline, then the year: freed figure 40/700 and "freed each year" 16 muted, a 358 × 28 track, the two rows at 16 muted and 18/700, and the note at 13/17.

## Wiring

Follow the mortgage wiring, one file at a time, once for each module.

- `js/state.js`: the two input keys in `createEmptyGenerated`, `normalizeGenerated` (including the mutual exclusions and the `videoSummary` clearing), and a selected-case id for each in `normalizeModuleUi`.
- `js/render.js`: a module check where `isCollegeFundingModule` is checked, and the mount, in the manner of `buildMortgageScenarioShell`. The assumptions and outputs cards still render from the engine's tables.
- `js/app.js`: selected-case get and set with persistence and the read-only guard, a Dev Panel example payload for each module, and `hasCalculatedGeneratedOutputs`.
- `js/presenter_catalogue.js`: kind, cases and default case, with stable ids (`keep`, `sell`; the ids in the payload for the home).
- `js/video_scene.js` and `js/codex_video_brief.js`: kind, label and the selected case's figures.
- `dev/rental-keep-or-sell-preview.html` and `dev/home-trade-down-preview.html`, in the manner of `dev/repayment-module-preview.html`, each with a `?preset=` parameter for the sample, a negative-result case and a four-case case.
- `package.json`: `check:rental-keep-or-sell` and `check:home-trade-down`, each with a `scripts/check-*.mjs`, listed wherever `check:house-purchase` is listed. Look in `.github/workflows` too.

Land it as two commits, rental first, so either can be reverted alone.

## Tests

The samples, which must reproduce exactly.

**Rental**

| | Keep | Sell |
|---|---|---|
| Start | 18,000 | 320,000 |
| Cuts | 13,000, 2,500, 3,700 | 6,000, 180,000, 21,000 |
| Running balance after each cut | 5,000, 2,500, −1,200 | 314,000, 134,000, 113,000 |
| Result | −1,200 | 113,000 |
| Zero line, % of plot | 12.4 | 8.0 |
| Start bar's right end, % of plot | 78 | 78 |

**Home**

| | Stay | Repay 18,000 | Repay 12,000 | No mortgage |
|---|---|---|---|---|
| Block 1 | 370,000 | 343,000 | 343,000 | 343,000 |
| Block 2 | 280,000 | 203,000 | 135,000 | 0 |
| Home budget | 650,000 | 546,000 | 478,000 | 343,000 |
| Repaid | 30,000 | 18,000 | 12,000 | 0 |
| Freed | 0 | 12,000 | 18,000 | 30,000 |
| Loan unrounded | | 202,788 | 135,192 | |

1. **Reference calculator.** In each `scripts/check-*.mjs`, a separate calculator that imports nothing from the engine and rebuilds every figure from first principles, as `check-college-funding-audit.mjs` does. For the home, use logarithms for the annuity rather than the engine's closed form, so the two cannot share a mistake.
2. **Invariants.** Rental: the result equals the start less the cuts, to €0.01, in every fixture. Home: `computeMonthlyPayment(loanUnrounded, rate, months) × 12` equals the case's repayment within €0.01; `block1 + block2` shown equals the budget shown; freed plus repaid equals `currentAnnualRepayments`; the budget never exceeds `homeValue`.
3. **Rejections** with the exact messages above, and for each: a negative, a non-finite number, a missing field, a fifth case, a duplicate id, an unknown key, a bad `baseScenarioId`.
4. **Layout, in Node.** For both modules at 1776 and at 358 wide: every label sits inside its container and no two labels overlap; the Sell bar's zero is at 8% and a result of −€10,000 on rent of €18,000 keeps every bar inside the plot; the home bar's scale is identical across the four cases.
5. **Motion discipline.** After any sequence of clicks, including a rapid one and one in a throttled tab, the drawn state equals a fresh render of the last case, and no two figures on the screen disagree.
6. **Words.** Render every case and scan the visible text and `aria-label`s for the banned phrases, a provider name, "p.a.", a bare hyphen used as a minus, and any amount without a thousands separator.
7. **Wiring.** Presenter case selection by id, the video scene and the codex video brief each resolve the selected case's figures. Extend `check-video-scene.mjs` and `check-codex-video-brief.mjs`.

Before finishing, run `npm run build`, both new `check:` scripts, `check:video-scene`, `check:codex-video-brief`, `check:consumer-session-payload` and `check:mortgage-math-audit`.

## Out of scope

- **Intelligent scenarios.** Choosing cases from a household's profile, deriving any figure from planner facts, consumer routing, voice, the manifest, the playbook and goal catalogue entries. I am doing that separately, and both engines take plain stated figures so it can feed them later. Follow the retirement precedent: do not edit `docs/prompt-pack/`.
- **Calculating tax.** `taxOnRentalProfitPerYear` and `taxOnGain` are stated. Do not call the tax engine. Deriving them is a later change on top of `docs/irish-tax-app-change.md`, whose Part B designs capital gains but is not built.
- **Trading down a rental** (sell this one, buy a smaller one). Parked. It needs a rent-for-each-euro assumption that does most of the work, and the cost and tax lines do not scale with price. If it is built, it is its own module with the assumptions visible and changeable on screen, not a variant of either of these.
- **A link between the two modules**, for example the rental's "in hand" feeding the home. It needs the existing mortgage's remaining term, which the sample does not give.
- **Amber and "tight".** Needs a threshold. Rental results are green, red, or level. I will draw those frames before they are built.
- **Cases the frames do not show.** A repayment above today's, trading up, a household with no mortgage, a rental with no rent, a second property.
- Changing `js/mortgage_math.js` or any central assumption.
- A shared shell or helper for these modules and the future cost fund.

## When you finish

End with a contract summary for the prompt pack, for each module: field names, the model, the rounding rule, every validation string, the derived copy templates, and the Dev Panel example. Keep to the repo's commit style: short plain-English commits describing what the client sees change.
