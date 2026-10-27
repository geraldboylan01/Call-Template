# Plan story view

The reading-column screen for a route's story, for plans built through the form and the AI analyst. Designed on the design canvas ("Option B, developed") and built in two slices: the data rules, the screen and the link hand-off; then the wiring into the app's overview. Sessions without a story are untouched.

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

## Files

| File | What it is |
|---|---|
| `js/plan_story_model.js` | Pure. Parses `{key}` and `{@key}`, fills them from the registry, refuses typed figures, ranking and advice wording, derives "See it in", builds the glance table. |
| `js/plan_story_session.js` | Pure. Normalises the `planStory` on a session; builds what the screen needs for one route (chapter titles come from the session's own modules). |
| `js/plan_story_view.js` | DOM: the page, the pill, the off-route note, the switch, and the return to a paragraph. |
| `js/plan_story_links.js` | The hand-off to the app, written against a list of calls the app supplies. |
| `js/plan_story_outline.js` | Finds the figure inside the module and rings it once. |
| `js/plan_story_app.js` | The controller `js/app.js` creates: draws the story and switch, opens links, shows the pill and note, handles return. |
| `styles/plan_story.css` | Uses the app's `:root` tokens. Linked from `app/index.html` and `app/session.html`. |
| `js/tests_plan_story_*.js`, `scripts/check-plan-story.mjs` | `npm run check:plan-story` (no browser). |
| `scripts/check-plan-story-browser.mjs` | `npm run check:plan-story-browser`. The real app on the demo session, at 1440 and 390 wide: every link, the ring, the return, off-route, the switch, reload. Needs Chrome and the repo's `node_modules`. |
| `dev/plan-story-demo.html` | Writes the demo session (the story's household built into eight real modules by the form's pipeline) and opens the app on it. |
| `dev/plan-story-preview.html` | The screen on its own against the sample story. `?updating=goals,risks`, `?offroute=1`, `?view=modules`. |

`js/app.js` changes: one controller, `planStory.syncOverview()` at the top of `refreshOverview` (it takes the switch's height off the grid's), `planStory.syncChrome()` at the end of `updateUiChrome`, Zoom Out goes back to the story when a link is open, and sessions with a story start in the overview.

## The contract

```
planStory { version: 1, routes, selectedRouteId, stories: { [routeId]: story }, registries: { [routeId]: registry },
            catalogue, chapterModules: { [chapterId]: sessionModuleId }, glanceNote }
story     { routeId, headline, summary, sections: [{ id, title, paragraphs | parts }] }
registry  { 'position.leftOver': { text: '€11,000 a year', source: { chapter, caseId?, nativeCaseId?, focusTargetId?, panel?, outlineText?, outlineSelector? } }
            'position.solvency': { notApplicable: 'There are no assets yet to measure against.' } }
catalogue { chapters: { household_cash_flow: { title, glyph } }, cases: { household_cash_flow: { today: 'Today' } } }
routes    [{ id, number, name, savingsUsed, leftOver, goalsCovered }]   // in the plan's order, never ranked
```

This is the same placeholder rule as the B1.5 brief: narration types no figures, `{@key}` is the only marker, and code builds every link from the registry, so a link can only open the module and case its figure came from.

**A figure is a link only where a module prints it.** In the sample story three figures have no module that prints them, so they are plain text: what is left over once the whole route is in place (€8,900), the mortgage after rates rise (€3,700) and the college saving after costs rise (€4,000). The cash flow module can only clear an outgoing or add to a pension, so its own case for clearing the car shows €17,000 left over, not the route's €8,900.

The browser check proves the other fifteen: each link opens the module the story named, on the case it named, and the ring is around the text that module prints for that figure. One of those is rounded in the story (the story says about €1,300 saved, the Car loan module prints €1,293).

## Not done yet

1. **A B1.5 checker rule that a linked figure equals what its module shows.** The browser check does this for the demo session. In the product the chapters are built from the same household facts, so they should agree by construction, but nothing proves it for a real plan: for every figure with a module source, compare it with the module's own output for that case. Decide at the same time how a rounded story figure ("about €1,300") is allowed to differ from the module's (€1,293).
2. **Module icons.** The marks in `PLAN_STORY_GLYPHS` are stand-ins.
3. **Route switching.** Choosing a route that has a story draws it; one without says it is updating. The recalculation that produces the other routes' stories is the analyst's side.
4. **Plan panels.** A link whose source is a `panel` (a part of the plan view rather than a module) says it is not on this screen yet.
5. **The ring uses the words the module prints.** `focusTargetId` is carried but not yet used; the presenter's focus targets could replace `outlineText` and `outlineSelector`.
