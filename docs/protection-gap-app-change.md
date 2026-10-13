# Protection gap: if one income stopped, how big is the hole and how long would savings fill it?

Status: design chosen 2026-10-13 (option C, "the months", with the money-in bar split into the State floor and take-home), not started. Stage 1 only.

## Context

A household with two incomes wants to know what happens if one stops. The question this module answers is **if one income stopped, how big is the hole, and how long would savings fill it?**

Nothing in the app answers it. `protection_analysis` (`docs/modules/protection_analysis.md`, `docs/prompt-pack/22_protection_playbook.md`) is a report-style playbook about income protection and serious-illness cover. It has no engine and it talks about cover and premiums. **This module is separate and must stay separate**: it shows the gap and the time and never a cover amount, a premium or a product. Do not edit `protection_analysis`.

Three options were explored. **Option C was chosen** and it is the only one to build:

- **C, the months** (chosen). One bar for how big the hole is: what comes in, built up from the State payment (the floor) and take-home, against what is needed, with the gap marked. Under it, a strip of 36 months for how long savings fill it.
- A (income steps down to a floor) and B (two stacks plus a savings column) were drawn and set aside. Do not build them.

The idea it must land: **the size of the hole, and the number of months savings fill it, read as shapes before any figure is read.** It is shared at 1920×1080 on a call while the adviser clicks between up to four cases, and re-opened later by the client alone on a laptop or phone. Nothing may depend on spoken context.

Tone: calm and factual on a hard subject. No alarm styling, no warning icons, no imagery of illness or death.

Reference frames, in the design canvas (private link: https://claude.ai/artifact/JRXfaVyTymypWMrpeq6p53):

| Frame | File | What it shows |
|---|---|---|
| `C · The months · Today` | `C1.dc.html` | 1920×1080, case 1 |
| `C · The months · Niamh cannot work` | `C2.dc.html` | 1920×1080, case 2 |
| `C · The months · Dara cannot work` | `C3.dc.html` | 1920×1080, case 3 |
| `C · The months · Niamh dies` | `C4.dc.html` | 1920×1080, case 4 |
| `C · The months · phone` | `C-phone.dc.html` | 390×1100, case 2 selected |

Things to know before you use them:

- They have **not been opened and checked in a browser**. Treat them as a drawing, not a reference implementation.
- They were drawn with the sample household's figures exactly as given (below). They draw no footnote. One is required (see Words).
- Where this brief and a frame disagree, the brief wins. Say which.

## Decisions to confirm

| # | Decision | Default used | Why it matters |
|---|---|---|---|
| D1 | Where take-home and State payments come from | **Stated in the payload.** Nothing is calculated. | The tax engine has no income type for an illness or survivor's payment and no per-person take-home under joint assessment. Stated figures keep the module from holding any tax rule. See Out of scope. |
| D2 | Module identity | New module `protection_gap`, kind `protection-gap`. `protection_analysis` untouched. | The hard limit (no cover, premium or product) makes merging with the report module wrong. |
| D3 | Title for the death case | `{Name} dies`, as drawn. Override with `title`. | The softest honest wording is the adviser's call, for example "If Niamh died". |
| D4 | What savings does | The stated total is used **only** to fill the gap, with no interest and no inflation, and the gap stays constant. | A longer horizon needs its own brief. |
| D5 | Months rounding | **Nearest month.** 60,000 against a 38,000 gap is 18.9, shown as 19. | Matches the sample (19 and 28). Rounding down would contradict it. |
| D6 | The horizon | 36 months. If the unrounded months are 36 or more: "beyond three years". | The sample's death case lasts far longer and gave no months figure. Never show a derived long figure. |
| D7 | Money in equals needed exactly | Not drawn. Build it plainly (see Edge cases) and report. | Frames first, then lift. |

## Defaults assumed

1. **Release surface.** Adviser-only through the Dev Panel, the presenter and the published session viewer. `consumer: false`. No consumer routing, voice or planner facts.
2. **One ordinary year.** Every amount is per year, in today's money.
3. **One event per case.** A case changes one thing: a person cannot work, or a person dies. Base case has none.
4. **Whole euros.** Amounts are stated as whole euros. Non-integers are rejected, not rounded.
5. **The words.** "Money in", "Money needed", "Gap", "Short", "Left over", "Filled by savings", "State payment", "survivor's pension". "Cover" never appears, in any sense.

## Before you write code

- Pull `main` and work on `module/protection-gap`. Do not build on another module's branch.
- Read `js/repayment_case_module.js` end to end. It is the closest precedent: same clock (`CLICK_MS`), same settling discipline, same `build...Module({ rawInputs, selectedCaseId, onSelectCase })` shape, same standalone preview (`dev/repayment-module-preview.html`).
- Read `docs/future-cost-fund-app-change.md` and the household cash flow brief (`docs/household-cash-flow-app-change.md`, on branch `module/household-cash-flow`). Both touch the same wiring files (`presenter_catalogue.js`, `state.js`, `render.js`, `app.js`). Land one module's wiring first and copy it. Reuse its motion rule, its hysteresis idea and its words check rather than writing new ones.
- Read `js/scenario_cap.js`, `js/presenter_catalogue.js` (`moduleKind`), `js/video_scene.js`, `js/codex_video_brief.js`, `js/state.js` (`normalizeGenerated`, `normalizeModuleUi`), `js/render.js`, `js/app.js`.
- Read `js/planning/income_basis.js` for why stated take-home is net, and the header of `js/planning/tax/engine.js` for why it is not used here.
- Then give a short plan: final field names, file list, where the pure layout function sits, how label placement is decided. **Wait for the go-ahead before implementing.**

## The contract

Add `generated.protectionGapInputs`. Engine in `js/protection_gap_math.js`, renderer in `js/protection_gap_module.js`, tests in `js/tests_protection_gap_math.js`.

### Inputs

| Field | Type | Rule |
|---|---|---|
| `householdLabel` | string, optional | Client-facing, for example "Niamh and Dara, both 45". 1 to 60 characters. |
| `people` | array, required | 1 to 2 of `{ id, label, takeHome }`. `id` unique, `[a-z0-9_-]`. `label` the name shown, 1 to 24 characters. `takeHome` net per year, whole euros, 0 or more. |
| `needed` | integer, required | What the household needs per year. Greater than 0. |
| `savings` | integer, required | Total savings that may fill a gap. 0 or more. |
| `baseScenarioId` | string, optional | Must match a case id. Default: the first case. |
| `scenarios` | array, required | 1 to `MAX_MODULE_SCENARIO_CASES` (4) cases, base included. |

Each case:

| Field | Type | Rule |
|---|---|---|
| `id` | string, required | Unique and stable (the presenter selects by id). |
| `title` | string, optional | Client-facing button name, up to 40 characters. Absent: derived (see Words). |
| `description` | string, optional | One sentence, for the presenter. |
| `event` | object, optional | None for the base case. One of the two below. |

The two events that have been designed, and so the only two in Stage 1:

| `type` | Fields | Meaning |
|---|---|---|
| `cannotWork` | `personId`, `statePayment` (integer > 0) | That person's take-home stops and a State payment of that amount starts. |
| `dies` | `personId`, `survivorsPension` (integer ≥ 0), `neededAfter` (integer > 0, optional), `neededBecause` (optional list of `mortgageCleared`, `livingCostsLower`) | That person's take-home stops, a survivor's pension starts, and money needed may fall. Needs two people. |

A case states what changes, never the result. There is no gap, months or left-over field: a payload that states any of them is rejected.

### The model

- `computeProtectionGapProjection(rawInputs)` per case:
  - `floor` = `statePayment` or `survivorsPension` (0 in the base case).
  - Each person's take-home counts unless it is the event person's.
  - `moneyIn` = `floor` + the counted take-homes.
  - `needed` = the case's `neededAfter`, else the household `needed`.
  - `gap` = `max(0, needed − moneyIn)`. `spare` = `max(0, moneyIn − needed)`.
  - `exactMonths` = `savings ÷ (gap ÷ 12)` when `gap > 0`. `months` = nearest whole month. `beyond` = `exactMonths ≥ 36`.
- Chart scale: `scaleMax` = `ceil(max over all cases of max(moneyIn, needed) × 1.05, to 10,000)`. 110,000 for the sample. **One scale for the module, the same in every case**, so nothing rescales on a click.
- The sample, which is the design fixture and the first test:

| | Today | Niamh cannot work | Dara cannot work | Niamh dies |
|---|---|---|---|---|
| Floor | none | State payment 13,000 | State payment 13,000 | Survivor's pension 13,500 |
| Take-home counted | 57,000 + 45,000 | 45,000 | 57,000 | 45,000 |
| Money in | 102,000 | 58,000 | 70,000 | 58,500 |
| Money needed | 96,000 | 96,000 | 96,000 | 60,000 |
| Gap / left over | 6,000 left over | 38,000 gap | 26,000 gap | 1,500 gap |
| Months | none | 19 (18.9) | 28 (27.7) | beyond three years (480) |

Savings 60,000. Niamh 57,000 and Dara 45,000 take-home, needed 96,000. The death case has `neededAfter: 60,000`, `neededBecause: [mortgageCleared, livingCostsLower]`.

### Outputs

`assumptionsTable`, `outputsTable` (one row per case), `tables`, `charts`, `debug`, in the college engine's shape. `debug.cases[]`: `id`, `title`, `description`, `event`, `segments[]` (`{ id, label, amount, kind: 'floor' | 'takeHome' }`), `moneyIn`, `needed`, `gap`, `spare`, `exactMonths`, `months`, `beyond`, `status` (`left_over`, `short`, `tight`), `headline`, `sentence`. `charts` carries one ordinary chart (the base case's segments against needed) for surfaces with no module to draw. `getProtectionGapCases(rawInputs)` returns `[{ id, title, description }]` for the presenter.

### Validation

Messages name the field and the case, in the existing style:

- `generated.protectionGapInputs.scenarios supports at most 4 cases; received 5.`
- `generated.protectionGapInputs.people[0].takeHome must be a whole number of euros.`
- `generated.protectionGapInputs.scenarios[3] (Niamh dies): needs two people in the household.`
- `generated.protectionGapInputs.scenarios[1] (Niamh cannot work): personId "niamh" has no take-home to stop.`
- `generated.protectionGapInputs.gap is not accepted. It is calculated.` Same for `months`, `spare`, `leftOver`.
- **The hard limit, at the boundary:** a payload key whose name is or contains `cover`, `premium`, `policy`, `product`, `provider`, `insurer` or `quote` is rejected: `generated.protectionGapInputs.<key>: this screen shows the gap and the time, never a cover amount, a premium or a product.`
- Also: duplicate ids, unknown event key, unknown `personId`, `baseScenarioId` not matching, more than one event in a case, an unknown `neededBecause` code.
- The session importer treats `scenarios` like the other capped arrays: tolerate on the way in, cap with an import warning, never throw. `protectionGapInputs` is mutually exclusive with the other engine keys in `normalizeGenerated`, handled as `collegeFundingInputs` is, and cleared by a `videoSummary`.

## On screen

### What is on it

One element carries the screen: the strip of months. Everything else is quiet. Reading order:

1. A muted module name and the household line, then the two-line answer (see Words).
2. The case buttons (two to four; one case: no buttons).
3. The one sentence saying what this case changes.
4. **"How big is the hole, in € a year"**: the money-in bar, its brackets, the need tick and the labels.
5. **"How long savings fill it"**: the months strip.
6. One muted footnote (see Words).

### One drawing, two layouts

There is one drawing. It scales with the module's own content width (measure with a `ResizeObserver` on the module root, fall back to `window.innerWidth`), not the device. Only the arrangement of buttons changes:

- Content width **1100 and up**: case buttons in a left rail 360 wide, chart column to the right.
- **760 to 1099**: four buttons in a row above the chart.
- **Under 760**: a 2×2 grid of buttons, then the chart.
- Keep a 16px hysteresis so a scrollbar appearing does not flip the layout.

Build the layout as a **pure function** (`layoutProtectionGap(model, { width })`) returning plain numbers and boxes, with no DOM, so geometry and label collisions can be tested in Node.

### The money-in bar

Reference is the 1920 frame: chart column 1296 wide, content width 1792. On a phone it is 358 wide (390 less 16 either side). Positions below are for the wide frame, with the phone values after a slash.

| Thing | Rule | Reference |
|---|---|---|
| Scale | chart width ÷ `scaleMax`. Starts at 0. Labels "0" and `scaleMax` under the ends. | 0.01178 px per € / 0.00326 |
| Track | The full chart width, raised surface | |
| Segments, left to right | State payment (or survivor's pension) first, then each take-home in the order of `people`. A zero segment has no width. | |
| Floor segment | Blue at 66%. A thin 1px dark hairline separates segments. | |
| Take-home segment | Blue at 38% | |
| Bar height | | 80 / 56 |
| Gap block | Red at 42%, from where money in ends to the need tick. If left over: green at 50%, from the tick to where money in ends. | |
| Brackets | 8px high, 2px at 55% text, 14px above the bar: one over money in, one over the gap (not drawn for left over) | |
| Need tick | 2px, text colour, 14px above and below the bar | |
| Labels above | "Money in" with the total, left-aligned at the bar start. The gap label ("Gap" and "€38,000 a year", or "Left over") centred over the gap block, clamped inside the chart. | 18/22 muted + 30/36 bold / 15/20 + 20/26 |
| Label below | "Money needed" with the figure, centred under the tick, clamped | same sizes |
| Segment labels | **Placed by the layout function.** Inside the segment when it is wide enough for its longest line plus 24px: name 18/22 600 and amount 28/32 700. Otherwise below the bar, left-aligned to the segment start, name 14/18 and amount 18/22. Nothing may be truncated. | State segment: inside on the wide frame (153px), below on a phone (42px) |

The State label is two lines inside ("State" / "payment", "Survivor's" / "pension") so it fits 153px.

### The months strip

36 cells, one per month, spanning the same left and right edges as the bar.

| Thing | Rule | Reference |
|---|---|---|
| Height | | 160 / 96 |
| Fill | Green at 50%, from the start to `months` cells. Beyond: full width. | |
| Short | Red at 42%, the rest. Absent when beyond. | |
| Dividers | 1px at 12% text per month, 40% at 12 and 24 | |
| Words inside | "Filled by savings" in the fill, "Short" in the short part when 140px wide or more (56px phone). Left over: "Nothing to fill". | 30/44 600 / 16/22 |
| End mark | 2×24px tick at the end of the fill. Above it, right-aligned to it: "Savings of €60,000 would last" 20/24 muted and the months at 64/72 800 ("19 months", "Beyond three years"). Phone: "Savings last" 15/20 and 32/40. | |
| Axis | Ticks and labels at 0 ("Income stops", or "Today" in the base case), 12, 24 and 36 months ("1 year", "2 years", "3 years") | 20/24 muted / 15/20 |

### Case buttons, type and colour

- Real `<button>`s in a group with an accessible name, `aria-pressed`, 72px high (56 on a phone), radius 8. Selected: a 2px blue border and a 14% blue fill, full text colour, bold. Unselected: a 1px hairline at 16%, raised surface, muted text. **Same outer size**, so nothing shifts on a click.
- Reuse the tokens in `styles/base.css` (`--bg-0`, `--bg-1`, `--text`, `--muted`, `--electric-blue`, `--accent-green`, `--accent-red`). Manrope. Tabular figures on every amount. Radius 12 on surfaces, 8 on controls. Styles go in `styles/base.css` under a `.pg-` prefix.
- New fills are variables, not inline: `--pg-floor` rgba(106,167,200,.66), `--pg-earn` rgba(106,167,200,.38), `--pg-short` rgba(201,111,98,.42), `--pg-filled` rgba(102,184,158,.5). Check text on `--pg-floor` is at least 4.5:1 (it is about 4.7).
- Blue is the selected case and neutral emphasis. Green is money left over or filled, always beside a word. Red is short, always beside "Gap" or "Short". Text is never in a series colour. Amber is used only for "Tight".

### Motion

- One clock for the module: `CLICK_MS` in `repayment_case_module.js` (520ms), ease-out cubic, with **its acceptance rule**: progress clamped and timed from the first frame, a monotonic token so a stale frame cannot repaint a case the client has left, and a settle timer that is never conditional.
- What moves: segment widths and positions, the gap block, brackets, the need tick, the strip's fill and short parts, the end mark and the labels that follow them. Nothing else. All text changes in the same frame as the click. Do not count figures up.
- A click while travelling starts from what is displayed. `prefers-reduced-motion: reduce` means the new case is drawn at once.
- Do not rebuild the subtree on a click. Do not use `js/scenario_motion.js`.

### Words

Plain, sentence case, euro with thousands separators, "a year" never "p.a.". It shows what is and what each case would change. Never "we recommend", "you should", "best option", "best", "ideal", "optimal", a product or provider name, or the words cover, premium, policy, insurer, insurance, quote, "income protection" or "serious illness". **No gendered pronouns anywhere**: sentences use the person's name.

Fallback case titles: base `Today`; `cannotWork` `{Name} cannot work`; `dies` `{Name} dies`.

The answer is two lines, derived, never typed:

| State | Line 1 | Line 2 |
|---|---|---|
| gap, months known | `{€gap} a year short.` | `Savings would last {n} months.` |
| gap, beyond | `{€gap} a year short.` | `Savings would last beyond three years.` |
| gap, no savings | `{€gap} a year short.` | `There are no savings to fill it.` |
| left over | `{€spare} a year left over.` | `Nothing for savings to fill.` |

The sentence under it is derived from the event:

| Event | Template |
|---|---|
| none, two people | `Both take-home pays come in, and {€needed} is needed.` |
| none, one person | `Take-home pay comes in, and {€needed} is needed.` |
| `cannotWork` | `{Name}’s take-home stops and a State payment starts. {€needed} is still needed.` |
| `dies`, needed unchanged | `{Name}’s take-home stops and a survivor’s pension starts. {€needed} is still needed.` |
| `dies`, needed lower | `{Name}’s take-home stops and a survivor’s pension starts. {€needed} is needed, because {reason}.` |

`reason`: both codes `the mortgage is cleared and living costs drop`; `mortgageCleared` only `the mortgage is cleared`; `livingCostsLower` only `living costs drop`.

The four sample sentences are golden strings:

1. `Both take-home pays come in, and €96,000 is needed.`
2. `Niamh’s take-home stops and a State payment starts. €96,000 is still needed.`
3. `Dara’s take-home stops and a State payment starts. €96,000 is still needed.`
4. `Niamh’s take-home stops and a survivor’s pension starts. €60,000 is needed, because the mortgage is cleared and living costs drop.`

Footnote, derived, one muted line (18/26 wide, 14/20 phone), **the one element not in a frame**: `Amounts are a year. Savings are used only to fill the gap, with no interest or inflation. State payments are as given and depend on each person’s PRSI record.` The last sentence needs the adviser's review before it ships.

### Accessibility

- Case buttons are real `<button>`s in a labelled group with `aria-pressed`.
- The drawing is `role="img"` with an `aria-label` that is the two-line answer plus the sentence. Visible labels are real text and are not read twice.
- The answer and sentence are `aria-live="polite"`.
- Touch targets at least 44px. Text contrast at least 4.5:1 (3:1 from 24px).
- Colour never carries meaning alone. Every colour sits beside a word.

### Edge cases

- One person: `cannotWork` is allowed (money in is the State payment only). `dies` is rejected.
- Savings 0 with a gap: the strip is all short and line 2 is "There are no savings to fill it."
- Months between 35.5 and 36 round to 36: the strip is full and the label reads "36 months". At 36 exactly or more unrounded it is "Beyond three years".
- **Money in equals needed (D7):** headline `Nothing left over, nothing short.`, no gap block, the tick at the end of the bar, the word "Tight" in amber beside the headline, and the strip as "Nothing to fill". Not drawn: build it plainly and report it.
- Money in above `scaleMax` cannot happen by construction. A long name wraps and never truncates.
- Amounts of €1m and over: compact ("€1.2m") on labels only.

## Wiring

Follow the sibling briefs' wiring, one file at a time, and resist a shared refactor in this change.

- `js/state.js`: `protectionGapInputs` in `createEmptyGenerated` and `normalizeGenerated` (mutual exclusions, `videoSummary` clearing), and the selected case in `normalizeModuleUi`.
- `js/render.js`: an `isProtectionGapModule` check beside the other engine modules, and the mount. The assumptions and outputs cards still render from the engine's tables.
- `js/app.js`: selected-case get and set with persistence and the read-only guard, a Dev Panel example payload using the four sample cases, and `hasCalculatedGeneratedOutputs`.
- `js/presenter_catalogue.js`: kind `protection-gap`, cases and default case, stable ids.
- `js/video_scene.js` and `js/codex_video_brief.js`: kind, label and the selected case's figures.
- `dev/protection-gap-preview.html`, in the manner of `dev/repayment-module-preview.html`, with `?cases=`, `?preset=` (the sample, one person, no savings, beyond, left over, tight) and `?width=`.
- `package.json`: `check:protection-gap`, `scripts/check-protection-gap.mjs`, listed wherever `check:house-purchase` is, including `.github/workflows/consumer-regression.yml` and `deploy-worker.yml`.
- No tax rule is copied or imported. Do not touch `docs/prompt-pack/`, the module manifest or the goal catalogue in this change.

## Tests

1. **Reference calculator.** In `scripts/check-protection-gap.mjs`, a separate calculator that imports nothing from the module and rebuilds each sample case from first principles. Every figure in the sample table equals it, including 18.9 → 19, 27.7 → 28 and 480 → beyond.
2. **Invariants over every case.** Shown money in equals the sum of shown segments. Gap equals needed minus money in. Gap and spare are never both above 0. A payload that states gap, months, spare or left over is rejected.
3. **Scale.** `scaleMax` is 110,000 for the sample and the same in every case. Bar and strip widths are identical across cases for a given width.
4. **Layout, in Node.** For all four cases at chart widths 1296, 1100, 800, 358 and 320: no two labels overlap, no label is crossed by a bar, tick or bracket, every box is inside the container, the State label is inside when it fits and below when it does not, and type never falls below 14px.
5. **Layout switch.** Buttons are a rail at 1100, a row at 760 and a grid at 759. A 15px jitter around a line does not flip it. The selected case survives and the engine is not rerun.
6. **Hard limit.** Render all four cases and scan visible text and every `aria-label` for cover, premium, policy, insurer, insurance, quote, "income protection", "serious illness", a product or provider name, the banned phrases above, "p.a.", gendered pronouns and any amount without a thousands separator. Reject each forbidden payload key with the exact message.
7. **Words.** The four sample sentences and the four answer pairs equal their templates' output.
8. **Motion discipline.** After any sequence of clicks, including a rapid one and one in a throttled tab, the drawn state equals a fresh render of the last case. With `prefers-reduced-motion` the new case is drawn at once.
9. **Wiring.** Presenter case selection by id; the video scene and codex video brief each resolve the selected case's figures. Extend `check-video-scene.mjs` and `check-codex-video-brief.mjs`.

Before finishing, run `npm run build`, `npm run check:protection-gap`, `check:video-scene`, `check:codex-video-brief` and `check:consumer-session-payload`. Then open `dev/protection-gap-preview.html` at 1920, 1366, 1024, 844 and 390 and look at it, because the frames have not been checked in a browser either. Only 1920 and 390 are drawn: report what looks wrong at the other widths rather than guessing.

## Out of scope

- **Calculated take-home and State payments.** Needs an income type in the tax engine for an illness or survivor's payment, a per-person take-home under joint assessment, and a source for State rates. Until then these are stated, and the surviving partner's changed tax position is not recalculated.
- **Duration limits and changes over time.** A State payment ending, the gap changing when a mortgage ends on a date, partial income loss, both people stopping, children.
- **Savings growth, inflation, or savings used for anything else.**
- **More than two people, or more than one event per case.**
- **The tight state's own design** (D7), and any "short" state beyond what is drawn.
- **Options A and B**, the report-style `protection_analysis` module, and anything about cover or premiums.
- **Consumer routing, voice, planner facts, manifest, playbook and goal catalogue entries.**

## When you finish

End with a contract summary for the prompt pack: field names, the model and the two events, the months and scale rules, every validation string, the derived copy templates and the layout breakpoints, plus the Dev Panel example. Keep to the repo's commit style: short plain-English commits describing what the client sees change.
