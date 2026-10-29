# Plan story view

The reading-column screen for a route's story, for plans built through the form and the AI analyst. Designed on the design canvas ("Option B, developed") and built in three slices: the data rules, the screen and the link hand-off; the wiring into the app's overview; and reading a compiled plan, with where each figure comes from and explainers. Sessions without a story are untouched.

## What the screen is

- A headline (serif) and one-line summary, then the story's sections in order, one reading column about 70 characters wide.
- A narrow right rail with only the route tabs (least to most change) and the at-a-glance table. The selected route has a column outline and "You're reading"; nothing is ranked, scored or coloured.
- Every figure that came from a module is a real link: dotted underline, a small module mark and a tooltip on hover or focus ("Car loan · Clear it now. Opens the module with €1,300 in interest outlined."). Esc dismisses the tooltip.
- Each section ends with "See it in", the modules it linked, in order of first use. Code derives it from the links; the analyst does not write it.
- A link opens the real module on this route's case with the figure ringed once, and a "Back to the story" pill above the module returns to the same paragraph. If the case is changed inside the module, a note says "This screen no longer follows the route", with "Back to the route".
- A route with no story yet says it is updating; sections still recalculating show "Updating" in place of text.
- On a phone the tabs become a strip and the glance table becomes cards, above the story.

## In the app

A session may carry one optional `planStory`. `js/state.js` normalises it with the rest of the session (a bad one is dropped with a warning and the session still opens), and a published snapshot carries it.

With a story, the overview shows, from the top: the **Story | Modules** switch, the story, then the module grid in its own zoomed-out box below. Modules shows the grid alone. A session with a story opens in the overview. Choosing a card in the grid opens its module the usual way.

Opening a link:

1. `openStoryLink` finds the session module the chapter became (`planStory.chapterModules`), sets its case through the bridges the app already exposes (`window.__set…Scenario`; `PLAN_STORY_CASE_BRIDGES`), and checks the case really changed. A module that is not yet open remembers the case and is drawn on it; one already open moves through its own control (`presenterSelectScenario`).
2. The module opens full size (no zoom animation), with the pill (and the off-route note, when it applies) in a row above it. The module is not covered, moved or restyled.
3. The figure is found by `outlineSelector` or by the words the module itself prints (`outlineText`, falling back to the story's own text), and ringed once.
4. "Back to the story", the app's own Zoom Out, or leaving the module by any other route to the overview scrolls the story to the paragraph the link was in.

## Reading a compiled plan

`js/plan_story_compiled.js` turns a compiled plan and a story into what the app opens.

```js
import { buildPlanStory, buildSessionFromPlan } from './js/plan_story_compiled.js';
const session = buildSessionFromPlan(compiled, { current: storyForCurrent, clear_car: storyForThatRoute });
```

`story` is B1.5 section 3's `story[routeId]`: an object keyed by route id (or one story with its own `routeId`). Nothing on the screen comes from the story but words.

- **Figures.** Every `{key}` and `{@key}` is filled from `readPlanPosition(compiled)` ([story facts](story-facts.md)) for that route: the fact's own text, its basis, and where it opens. `{figure.<id>}` is read from the figures register (`getFigures`, on the plan's calculation date). `{current.<key>}` is the current position's fact, with the current route's source. A key the plan did not produce, a figure the register does not hold, a fact that is missing or not applicable, a story under the wrong route, and a story for a route the plan does not hold are all refused with the route and path (`PlanStoryError`). A story cannot reach another alternative's facts: its keys name only its own route and `current.`.
- **Modules and cases.** The session holds one module for every compiled case the routes use, in the order the routes first use them, and **the module's id is the compiled case id**. A route's `chapterCases` names its case of each chapter; a link carries that `caseId` and the `nativeCaseId` that selects the case inside the module (`planStory.caseModules` maps a case to its chapter, so the app finds the module's case controls). Routes that share a case share a module. The focus target in a fact names the module by a fingerprint of how the compiler built it, so it is looked up again in the session's own module; a target the session's module does not hold is dropped and the link opens the module on its case without a ring.
- **Plan figures.** A fact the plan works out itself (a ledger total, a difference from today) has no module, so a link on it opens the plan view's own panel, which the app does not have yet and says so.
- **At a glance.** Each route's column is the plan's own figures: cash the route uses (resource ledger), what is left over a year (whole euros), and the goals covered. Each carries a basis.
- **Goals.** The goals section tells each goal in its own subsection (`goals: [{ goalId, title, parts }]`), in the ledger's order.

### Where a figure comes from

Hovering over, focusing or tapping any figure shows its basis, written by `js/plan_story_basis.js` from the fact's `basis` alone. The kind is a word with a mark, never only a colour:

| Kind | Says |
|---|---|
| stated | **You told us**, with the form question it answers (the form's own wording) and the day the form was confirmed. A plan input that has no form question says so and invents no wording. |
| calculated | **Worked out by the app**, naming the module the figure's source names, or the engine (the resource ledger, the Irish tax calculations, your form answers). A mixed calculation lists what it is made of, each with its own basis. |
| assumption | **A Planeir assumption**, with its plain basis and its disclosure. |
| official | **An official figure**, with its source (a link) and the day it was checked. |

Plain figures are buttons with a dashed underline and a help cursor; linked figures keep their dotted underline, and their popover also says what the link opens. On a touch screen the first tap on a linked figure shows its basis, with a button in the popover to open the module; a second tap also opens it. Esc closes a popover; it stays on screen at 390 and 1440 wide.

### Explainers

`{?explainer.<id>}` after a phrase adds a small info marker (a real button with its own mark). Hover, focus or tap shows the explainer's title, its sentences, its official sources and the day they were read, exactly as `getExplainers` holds them. The story cannot reword one. The session carries the explainers the story names (`planStory.explainers`), so a snapshot is self-contained; an id the catalogue does not hold is refused with its path. A fact's own `explainerId` shows its explainer inside the figure's popover.

### Opening a run

```sh
npm run --silent analyst:open -- private/analyses/<requestId>/<runId>
```

reads the run's case file (it never changes it), compiles the pinned plan with the current position and every route the analyst submitted a story for, builds the session, and writes `session.json` beside the case file (private, git-ignored). It prints how to open it: serve the folder (`node scripts/dev-static-server.mjs`), run the local worker as the README describes, and open `dev/plan-story-open.html?session=/private/analyses/<requestId>/<runId>/session.json`, which puts the session into the app's browser storage (asking first if one is there) and opens the story.

**One set of keys.** `read_position` and `price_route` list `storyFacts`, the keys a story may use, and `submit_story` checks a story against the same facts the screen opens (`js/plan_story_registry.js`), including `{figure.<id>}` and explainers. A key from the older metrics registry (`facts`) still passes the older checks, but submission says `openOnStoryScreen: false` and lists `keysNotOnStoryScreen`, and `analyst:open` refuses it with the path.

## Files

| File | What it is |
|---|---|
| `js/plan_story_model.js` | Pure. Parses `{key}`, `{@key}` and `{?explainer.<id>}`, fills them from the registry, refuses typed figures, ranking and advice wording, derives "See it in", builds the glance table. |
| `js/plan_story_basis.js` | Pure. The words for where a figure comes from, from its basis. |
| `js/plan_story_registry.js` | Pure. A plan's facts as the registry the screen resolves against; the placeholders a story names. Shared by `buildPlanStory` and the analyst's `submit_story`. |
| `js/plan_story_compiled.js` | `buildPlanStory` and `buildSessionFromPlan`: a compiled plan and a story become what the app opens. |
| `js/plan_story_session.js` | Pure. Normalises the `planStory` on a session; builds what the screen needs for one route (chapter titles come from the session's own modules). |
| `js/plan_story_view.js` | DOM: the page, the pill, the off-route note, the switch, and the return to a paragraph. |
| `js/plan_story_links.js` | The hand-off to the app, written against a list of calls the app supplies. |
| `js/plan_story_outline.js` | Finds the figure inside the module and rings it once. |
| `js/plan_story_app.js` | The controller `js/app.js` creates: draws the story and switch, opens links, shows the pill and note, handles return. |
| `styles/plan_story.css` | Uses the app's `:root` tokens. Linked from `app/index.html` and `app/session.html`. |
| `js/tests_plan_story_*.js`, `scripts/lib/plan-story-compiled*.mjs`, `scripts/check-plan-story.mjs` | `npm run check:plan-story` (no browser): the model, links, session, the words for every basis kind, explainers, and a real compile of made-up households (links by compiled case, every figure against its fact, refusals, `analyst:open`). |
| `scripts/analyst-open.mjs`, `dev/plan-story-open.html` | `npm run analyst:open`: a run's case file to a session the local app opens. |
| `scripts/check-plan-story-browser.mjs` | `npm run check:plan-story-browser`. The real app at 1440 and 390 wide, on the demo session (every link, the ring, the return, off-route, the switch, reload) and on a compiled made-up couple and borrower (links by compiled case, hover or tap, focus and Esc, explainers, the form question behind a stated figure). Needs Chrome and the repo's `node_modules`. |
| `dev/plan-story-demo.html` | Writes the demo session (the story's household built into eight real modules by the form's pipeline) and opens the app on it. |
| `dev/plan-story-preview.html` | The screen on its own against the sample story. `?updating=goals,risks`, `?offroute=1`, `?view=modules`. |

`js/app.js` changes: one controller, `planStory.syncOverview()` at the top of `refreshOverview` (it takes the switch's height off the grid's), `planStory.syncChrome()` at the end of `updateUiChrome`, Zoom Out goes back to the story when a link is open, and sessions with a story start in the overview.

## The contract

```
planStory { version: 1, routes, selectedRouteId, stories: { [routeId]: story }, registries: { [routeId]: registry },
            catalogue, chapterModules: { [chapterId]: sessionModuleId }, glanceNote }
story     { routeId, headline, summary, sections: [{ id, title, paragraphs | parts }] }
registry  { 'position.leftOver': { text: '€11,000 a year', source: { chapter, caseId?, nativeCaseId?, focusTargetId?, panel?, outlineText?, outlineSelector? } }
            'position.solvency.notApplicable': { text: 'There are no assets yet to measure against.', source: { panel: 'current_position' } } }
catalogue { chapters: { household_cash_flow: { title, glyph } }, cases: { household_cash_flow: { today: 'Today' } } }
routes    [{ id, number, name, savingsUsed, leftOver, goalsCovered }]   // in the plan's order, never ranked
```

This is the same placeholder rule as the B1.5 brief: narration types no figures, `{@key}` is the only marker, and code builds every link from the registry, so a link can only open the module and case its figure came from.

**A figure is a link only where a module prints it.** In the sample story three figures have no module that prints them, so they are plain text: what is left over once the whole route is in place (€8,900), the mortgage after rates rise (€3,700) and the college saving after costs rise (€4,000). The cash flow module can only clear an outgoing or add to a pension, so its own case for clearing the car shows €17,000 left over, not the route's €8,900.

The browser check proves the other fifteen: each link opens the module the story named, on the case it named, and the ring is around the text that module prints for that figure. The sample loan figure now uses the module’s €1,293 and the pension state uses the module’s “strong position”; a successful sample check still does not validate a compiled plan.

## B1.5 alignment and remaining work

The [full comparison with B1.5 sections 1 and 3](plan-story-b15-alignment.md) lists every difference, the small fixes made here and the larger work left to connect.

The model now requires all nine sections in order, including `ledger`. A declared `parts` object needs all five education-only parts. Paragraphs remain a preview format; resolving a preview is not a passed B1.5 completeness check. Section headings obey the same placeholder and no-typed-figures rules as the body. Every referenced placeholder has a module or plan-panel source; reasons use explicit `{key.notApplicable}` keys.

Links use the registered `nativeCaseId` to select a module case where supplied, preserving the chapter’s `caseId`. Supplied presenter target IDs are validated against their module and native scenario and take precedence over text/selector hints. Existing holdings, metrics, rows, timeline events and disclosures can be outlined. Exact chart-point attention and plan-panel navigation are still unavailable and are refused rather than replaced with an unrelated figure. Links without presenter targets still use the sample display hints.

The first of the two main connections is made (see Reading a compiled plan above): the session's story, facts, sources, modules and route summaries now come from a compiled plan, including current-position facts and each route's `chapterCases`. The second remains:

1. Implement the B1.5 checker rule that **every linked figure equals the linked module’s figure for the compiled route’s case**, including its native case, focus target, underlying value, unit, rounding and formatting. Use compiled inputs, results and versions; samples are not evidence for this rule.

The comparison also records the content/what-if/limitation floor, ordered goal subsections, all five parts throughout the authored story, semantic wording checks, registered figures, plan panels, chart points and route recalculation. The module glyphs remain stand-ins.

Also still open: the balance sheet's summary row (net worth) is in the presenter catalogue but the live balance sheet does not mark it, so a net-worth link opens the balance sheet on its case and rings nothing; plan-view panels for plan-owned figures; and the analyst skills' `{?explainer.state_pension_not_inherited}` example, whose catalogue id is `state_pension_not_passed_on`.
