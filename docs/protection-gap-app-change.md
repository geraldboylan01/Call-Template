# Protection gap: if one income stopped, how big is the hole and how long would savings fill it?

Status: design chosen (option C, "the months", with the money-in bar split into the State floor and take-home), decisions confirmed 2026-10-13. **Built: the engine, the screen and the app wiring (branch `module/protection-gap`).** Stage 1 only.

## Build status

Everything in Stage 1 is built, in the order of "Wiring a new engine module" in `docs/future-cost-fund-app-change.md`, each step with its own commit and its own check green.

- `js/protection_gap_math.js`: the engine (stated take-home, State payment, savings; one event per case).
- `js/protection_gap_view.js`: the words the screen adds, the geometry for any width, the button arrangement with hysteresis and where every label sits, with no DOM, so they are checked in Node.
- `js/protection_gap_module.js`: the drawing, the 520ms clock and `presenterSelectScenario`.
- State, paste pipeline (with the `ensureGenerated` refresh), render, app, presenter catalogue, video scene and codex brief wiring, the Dev Panel example, `dev/protection-gap-preview.html`, the `.pg-` styles and the CI listing.
- `npm run check:protection-gap` runs five groups: the engine against its reference calculator (a month-by-month drain of the savings, 300 generated households), and the engine, view, module and wiring suites. The video scene and codex brief are proved in `check-video-scene.mjs` and `check-codex-video-brief.mjs`.

Looked at in a real browser, from `dev/protection-gap-preview.html`: 1920, 1366, 1024, 844 and 390 wide, every case, and the motion. In a real tab a click moves the segments, the gap, the need tick and the green and red together over about 470ms on an ease-out and lands exactly on the new case's settled values. The words change in the click's own frame, and the bar and strip heights never move. A rapid click-through of eight cases ends on a fresh render of the last one.

Differences from this brief as first written:

- The wiring list is the section's, not this brief's own. It added `js/module_pipeline.js`, the presenter hook in `js/app.js`, the video and codex selection and the charts guard in `js/render.js`.
- The strip has red only when something is short. A case with nothing to fill (left over, or tight) shows a neutral track and "Nothing to fill". The first build drew all of it red; this was found by looking at it.
- The word "Tight" sits on the same line as the first line of the answer, in amber.
- The strip's green is named "Filled by your savings" when it is long enough, and "Filled" when it is not. When it is shorter still, the end mark ("19 months") carries the meaning.
- A State payment too narrow to hold its name is labelled just below the bar, at the start of its segment, with its amount. On a wide screen it is inside its segment.
- Labels that would touch take a second row, and the rows are reserved for the worst case, so the container is the same height in every case.
- In the rail arrangement the chart is the module's width less 496 (360 rail, 116 gap, 20 inset). Between 1100 and 1215 wide that leaves the chart under 720, so it uses the narrow type beside the rail. This is the arrangement the brief asked for; check it by eye if it ever looks cramped.
- The video's summary is the engine's answer and sentence, not the model's, so the video says what the screen says.
- `euroText` is exported from the engine, because the view formats amounts the same way.
- The `ensureGenerated` refresh is in, although the engine reads no central assumption, so every engine module's derived tables follow one path.

Not built, on purpose: the hover read-off the repayment module has, the tight state's own design (D7: it is built plainly and reported), and the consumer stage (module registry, manifest, playbook, routing, planner facts). `protection_analysis` and `docs/prompt-pack/` are untouched. The canvas frames still use the old third-person words; the words in this brief win.

## Context

A household with two incomes wants to know what happens if one stops. The question this module answers is **if one income stopped, how big is the hole, and how long would savings fill it?**

Nothing in the app answers it. `protection_analysis` (`docs/modules/protection_analysis.md`, `docs/prompt-pack/22_protection_playbook.md`) is a report-style playbook about income protection and serious-illness cover. It has no engine and it talks about cover and premiums. **This module is separate and must stay separate**: it shows the gap and the time and never a cover amount, a premium or a product. Do not edit `protection_analysis`.

Three options were explored. **Option C was chosen** and it is the only one to build:

- **C, the months** (chosen). One bar for how big the hole is: what comes in, built up from the State payment (the floor) and take-home, against what is needed, with the gap marked. Under it, a strip of 36 months for how long savings fill it.
- A (income steps down to a floor) and B (two stacks plus a savings column) were drawn and set aside. Do not build them.

The idea it must land: **the size of the hole, and the number of months savings fill it, read as shapes before any figure is read.** It is shared at 1920×1080 on a call while the adviser clicks between up to four cases, and re-opened later by the client alone on a laptop or phone. Nothing may depend on spoken context.

Tone: calm and factual on a hard subject. No alarm styling, no warning icons, no imagery of illness or death.

Where the figures come from: in Stage 1 they are **stated in the payload**. In a plan they will come from the household cash flow result (brief: `docs/household-cash-flow-app-change.md`, branch `module/household-cash-flow`). That is a later source swap behind the same field names, so **do not rename the fields** and do not build the link now.

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
- **They disagree with this brief in the words, on purpose.** The frames speak about the household in the third person ("Money in", "Money needed", "Savings of €60,000 would last", "€96,000 is still needed") and title the death case "Niamh dies". This brief speaks to the client as "you" and titles it "If Niamh died". The brief wins. Layout, sizes, colours and geometry are as drawn.
- Where this brief and a frame disagree anywhere else, the brief wins. Say which.

## Decisions

Confirmed 2026-10-13 unless marked.

| # | Decision | Answer | Notes |
|---|---|---|---|
| D1 | Where take-home and State payments come from | **Stated in the payload, accepted for Stage 1.** Nothing is calculated. In a plan they will come from the household cash flow result, so the field names stay as they are (`people[].takeHome`, `event.statePayment`, `event.survivorsPension`, `event.neededAfter`). | The tax engine has no income type for an illness or survivor's payment and no per-person take-home under joint assessment. Stated figures keep the module from holding any tax rule. See Out of scope. |
| D2 | Module identity | New module `protection_gap`, kind `protection-gap`. `protection_analysis` untouched. **Not raised in review: still the default.** | The hard limit (no cover, premium or product) makes merging with the report module wrong. |
| D3 | Title for the death case | **`If {Name} died`.** Override with `title`. | Only the death case changed. `{Name} cannot work` stays as drawn. If the pair should read alike ("If Niamh cannot work"), say so before building. |
| D4 | What savings does | The stated total is used **only** to fill the gap, with no interest and no inflation, and the gap stays constant. | A longer horizon needs its own brief. |
| D5 | Months rounding | **Nearest month.** 60,000 against a 38,000 gap is 18.9, shown as 19. | Matches the sample (19 and 28). Rounding down would contradict it. |
| D6 | The horizon | 36 months. If the unrounded months are 36 or more: "beyond three years". | The sample's death case lasts far longer and gave no months figure. Never show a derived long figure. |
| D7 | Money in equals needed exactly | Not drawn. Build it plainly (see Edge cases) and report. | Frames first, then lift. |
| D8 | Voice | **"You" in all on-screen words.** The client is "you". People are named. No gendered pronouns. | Applies to the answer, the sentence, the labels, the strip, the footnote and the accessible labels. |

## Defaults assumed

1. **Release surface.** Adviser-only through the Dev Panel, the presenter and the published session viewer. `consumer: false`. No consumer routing, voice or planner facts.
2. **One ordinary year.** Every amount is per year, in today's money.
3. **One event per case.** A case changes one thing: a person cannot work, or a person dies. The base case has none.
4. **Whole euros.** Amounts are stated as whole euros. Non-integers are rejected, not rounded.
5. **The words.** "What comes in", "What you need", "Gap", "Short", "Left over", "Filled by your savings", "State payment", "survivor's pension". "Cover" never appears, in any sense.

## Before you write code

- **The engine first, now.** `js/protection_gap_math.js`, `js/tests_protection_gap_math.js` and `scripts/check-protection-gap.mjs` touch no wiring, so they can be built before the future cost fund screen lands. Pull `main`, then work on `module/protection-gap`. Do not build on another module's branch.
- **The screen and wiring wait** until the future cost fund screen has landed. It sets the pattern for wiring a new engine module.
- Copy its wiring file by file: `js/state.js`, `js/render.js`, `js/app.js`, `js/presenter_catalogue.js`, `js/video_scene.js`, `js/codex_video_brief.js`, its preview page, its check script, and the `package.json` and workflow lists. Reuse its motion rule, hysteresis and words check rather than writing new ones. Read `docs/future-cost-fund-app-change.md` for the discipline (a pure layout function, one motion clock, two fixtures).
- Read `js/repayment_case_module.js` end to end. It is the closest precedent: same clock (`CLICK_MS`), same settling discipline, same `build...Module({ rawInputs, selectedCaseId, onSelectCase })` shape, same standalone preview (`dev/repayment-module-preview.html`).
- Read `docs/household-cash-flow-app-change.md`. It will be the source of these figures in a plan, and it touches the same wiring files.
- Read `js/scenario_cap.js`, `js/presenter_catalogue.js` (`moduleKind`), and `js/state.js` (`normalizeGenerated`, `normalizeModuleUi`).
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
| `cannotWork` | `personId`, `statePayment` (integer ≥ 0) | That person's take-home stops. A positive State payment starts; 0 means none. |
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

| | Today | Niamh cannot work | Dara cannot work | If Niamh died |
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
- `generated.protectionGapInputs.scenarios[3] (If Niamh died): needs two people in the household.`
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
5. **"How long your savings fill it"**: the months strip.
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
| Brackets | 8px high, 2px at 55% text, 14px above the bar: one over what comes in, one over the gap (not drawn for left over) | |
| Need tick | 2px, text colour, 14px above and below the bar | |
| Labels above | "What comes in" with the total, left-aligned at the bar start. The gap label ("Gap" and "€38,000 a year", or "Left over") centred over the gap block, clamped inside the chart. | 18/22 muted + 30/36 bold / 15/20 + 20/26 |
| Label below | "What you need" with the figure, centred under the tick, clamped | same sizes |
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
| Words inside | "Filled by your savings" in the fill, "Short" in the short part when 140px wide or more (56px phone). Left over: "Nothing to fill". | 30/44 600 / 16/22 |
| End mark | 2×24px tick at the end of the fill. Above it, right-aligned to it: "Your savings of €60,000 would last" 20/24 muted and the months at 64/72 800 ("19 months", "Beyond three years"). Phone: "Your savings last" 15/20 and 32/40. | |
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

Plain, sentence case, euro with thousands separators, "a year" never "p.a.". It shows what is and what each case would change. **The client is "you"** (D8): "you", "your", "you need". People are named, and the sentences use the name, never "he" or "she". Never "we recommend", "you should", "best option", "best", "ideal", "optimal", a product or provider name, or the words cover, premium, policy, insurer, insurance, quote, "income protection" or "serious illness". "You should" is banned even though the screen says "you".

Fallback case titles: base `Today`; `cannotWork` `{Name} cannot work`; `dies` `If {Name} died` (D3).

The answer is two lines, derived, never typed:

| State | Line 1 | Line 2 |
|---|---|---|
| gap, months known | `You are {€gap} a year short.` | `Your savings would last {n} months.` |
| gap, beyond | `You are {€gap} a year short.` | `Your savings would last beyond three years.` |
| gap, no savings | `You are {€gap} a year short.` | `You have no savings to fill it.` |
| left over | `You have {€spare} a year left over.` | `There is nothing for your savings to fill.` |

The sentence under it is derived from the event:

| Event | Template |
|---|---|
| none, two people | `Both of your take-home pays come in, and you need {€needed}.` |
| none, one person | `Your take-home pay comes in, and you need {€needed}.` |
| `cannotWork` | With a positive payment: `{Name}’s take-home stops and a State payment starts. You still need {€needed}.` With 0: `{Name}’s take-home stops. You still need {€needed}.` |
| `dies`, needed unchanged | `{Name}’s take-home stops and a survivor’s pension starts. You still need {€needed}.` |
| `dies`, needed lower | `{Name}’s take-home stops and a survivor’s pension starts. You need {€needed}, because {reason}.` |

`reason`: both codes `your mortgage is cleared and your living costs drop`; `mortgageCleared` only `your mortgage is cleared`; `livingCostsLower` only `your living costs drop`.

The four sample sentences are golden strings, and so are the four answer pairs:

1. `Both of your take-home pays come in, and you need €96,000.`
2. `Niamh’s take-home stops and a State payment starts. You still need €96,000.`
3. `Dara’s take-home stops and a State payment starts. You still need €96,000.`
4. `Niamh’s take-home stops and a survivor’s pension starts. You need €60,000, because your mortgage is cleared and your living costs drop.`

Answer pairs: `You have €6,000 a year left over.` / `There is nothing for your savings to fill.`; `You are €38,000 a year short.` / `Your savings would last 19 months.`; `You are €26,000 a year short.` / `Your savings would last 28 months.`; `You are €1,500 a year short.` / `Your savings would last beyond three years.`

Household line in the header: the `householdLabel`, then `Your savings €60,000` (from `savings`).

Footnote, derived, one muted line (18/26 wide, 14/20 phone), **the one element not in a frame**:

> Amounts are a year. Your savings are used only to fill the gap, with no interest or inflation. State payments are as given and depend on eligibility. When one income stops, the other person’s tax can change, so your take-home may differ from what is shown.

### Irish payment references, checked 16 October 2026

See [the current and announced Irish payment reference](irish-illness-disability-payment-reference.md). `statePayment` stays a confirmed yearly figure; missing entitlement information is not converted to 0, and a published maximum is not assigned automatically. The original €13,000 illustration is a stated design fixture, not a claim about the current maximum rate.

The PRSI sentence is approved as written. The last sentence carries the approved meaning in this wording; if it is edited, the golden string changes with it.

### Accessibility

- Case buttons are real `<button>`s in a labelled group with `aria-pressed`.
- The drawing is `role="img"` with an `aria-label` that is the two-line answer plus the sentence. Visible labels are real text and are not read twice.
- The answer and sentence are `aria-live="polite"`.
- Touch targets at least 44px. Text contrast at least 4.5:1 (3:1 from 24px).
- Colour never carries meaning alone. Every colour sits beside a word.

### Edge cases

- One person: `cannotWork` is allowed (what comes in is the State payment only). `dies` is rejected.
- Savings 0 with a gap: the strip is all short and line 2 is "You have no savings to fill it."
- Months between 35.5 and 36 round to 36: the strip is full and the label reads "36 months". At 36 exactly or more unrounded it is "Beyond three years".
- **What comes in equals what you need (D7):** line 1 `You have exactly what you need.`, line 2 `There is nothing for your savings to fill.`, no gap block, the tick at the end of the bar, the word "Tight" in amber beside line 1, and the strip as "Nothing to fill". Not drawn: build it plainly and report it.
- Money in above `scaleMax` cannot happen by construction. A long name wraps and never truncates.
- Amounts of €1m and over: compact ("€1.2m") on labels only.

## Wiring

Copy the future cost fund screen's wiring, one file at a time, and resist a shared refactor in this change.

- `js/state.js`: `protectionGapInputs` in `createEmptyGenerated` and `normalizeGenerated` (mutual exclusions, `videoSummary` clearing), and the selected case in `normalizeModuleUi`.
- `js/render.js`: an `isProtectionGapModule` check beside the other engine modules, and the mount. The assumptions and outputs cards still render from the engine's tables.
- `js/app.js`: selected-case get and set with persistence and the read-only guard, a Dev Panel example payload using the four sample cases, and `hasCalculatedGeneratedOutputs`.
- `js/presenter_catalogue.js`: kind `protection-gap`, cases and default case, stable ids.
- `js/video_scene.js` and `js/codex_video_brief.js`: kind, label and the selected case's figures.
- `dev/protection-gap-preview.html`, in the manner of its sibling preview pages, with `?cases=`, `?preset=` (the sample, one person, no savings, beyond, left over, tight) and `?width=`.
- `package.json`: `check:protection-gap`, `scripts/check-protection-gap.mjs`, listed wherever the future cost fund check is, including `.github/workflows/consumer-regression.yml` and `deploy-worker.yml`.
- No tax rule is copied or imported. Do not touch `docs/prompt-pack/`, the module manifest or the goal catalogue in this change.

## Tests

1. **Reference calculator.** In `scripts/check-protection-gap.mjs`, a separate calculator that imports nothing from the module and rebuilds each sample case from first principles. Every figure in the sample table equals it, including 18.9 → 19, 27.7 → 28 and 480 → beyond.
2. **Invariants over every case.** Shown money in equals the sum of shown segments. Gap equals needed minus money in. Gap and spare are never both above 0. A payload that states gap, months, spare or left over is rejected.
3. **Scale.** `scaleMax` is 110,000 for the sample and the same in every case. Bar and strip widths are identical across cases for a given width.
4. **Layout, in Node.** For all four cases at chart widths 1296, 1100, 800, 358 and 320: no two labels overlap, no label is crossed by a bar, tick or bracket, every box is inside the container, the State label is inside when it fits and below when it does not, and type never falls below 14px.
5. **Layout switch.** Buttons are a rail at 1100, a row at 760 and a grid at 759. A 15px jitter around a line does not flip it. The selected case survives and the engine is not rerun.
6. **Hard limit.** Render all four cases and scan visible text and every `aria-label` for cover, premium, policy, insurer, insurance, quote, "income protection", "serious illness", a product or provider name, the banned phrases above, "p.a." and any amount without a thousands separator. Reject each forbidden payload key with the exact message.
7. **Voice.** The same scan finds no "he", "she", "his", "her", "the household" or "the client" on screen, and finds "you" or "your" in the answer, the sentence and the footnote.
8. **Words.** The four sample sentences, the four answer pairs, the four titles (`Today`, `Niamh cannot work`, `Dara cannot work`, `If Niamh died`) and the footnote equal their templates' output.
9. **Motion discipline.** After any sequence of clicks, including a rapid one and one in a throttled tab, the drawn state equals a fresh render of the last case. With `prefers-reduced-motion` the new case is drawn at once.
10. **Wiring.** Presenter case selection by id; the video scene and codex video brief each resolve the selected case's figures. Extend `check-video-scene.mjs` and `check-codex-video-brief.mjs`.

Before finishing, run `npm run build`, `npm run check:protection-gap`, `check:video-scene`, `check:codex-video-brief` and `check:consumer-session-payload`. Then open `dev/protection-gap-preview.html` at 1920, 1366, 1024, 844 and 390 and look at it, because the frames have not been checked in a browser either. Only 1920 and 390 are drawn: report what looks wrong at the other widths rather than guessing.

## Out of scope

- **Calculated take-home and State payments.** In a plan they will come from the household cash flow result behind the same field names. That link is not built in Stage 1. Stated figures mean the other person's changed tax position (for example after a death) is not recalculated here, which is why the footnote says take-home may differ. Calculating State payments needs an income type in the tax engine, a per-person take-home under joint assessment, and a source for State rates.
- **Duration limits and changes over time.** A State payment ending, the gap changing when a mortgage ends on a date, partial income loss, both people stopping, children.
- **Savings growth, inflation, or savings used for anything else.**
- **More than two people, or more than one event per case.**
- **The tight state's own design** (D7), and any "short" state beyond what is drawn.
- **Options A and B**, the report-style `protection_analysis` module, and anything about cover or premiums.
- **Consumer routing, voice, planner facts, manifest, playbook and goal catalogue entries.**

## When you finish

End with a contract summary for the prompt pack: field names, the model and the two events, the months and scale rules, every validation string, the derived copy templates and the layout breakpoints, plus the Dev Panel example. Keep to the repo's commit style: short plain-English commits describing what the client sees change.
