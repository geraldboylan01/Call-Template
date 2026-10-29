# The B1.5 story checker

`checkStory(compiledPlan, story)` from `js/planning/plan_pack/story_checker.js` is the full Draft 1 check used by the `submit_story` executor. It is synchronous, does no I/O, uses no system date, changes neither argument, and returns every applicable refusal as `{code, path, message}`. Its result is `{ok, verdict, checkerVersion, routeId, refusals, links, limitations}`. A pass never releases an analysis.

```js
import { checkStory, getStoryRequirements } from '../js/planning/plan_pack/story_checker.js';
const requirements = getStoryRequirements(compiledPlan, 'current');
const verdict = checkStory(compiledPlan, authoredStory);
```

`getStoryRequirements` supplies code-owned requirements and limitation facts to the caller preparing a draft. It combines `readPlanPosition` with the compiled goal order, ledger years, protection cases and shared lever classification. Its `facts` come from `readPlanPosition`, including `limitations.<id>` text facts. The checker and screen use the same `storyFactRegistry`, `figureEntry` and narration parser; a checked placeholder must resolve on the screen too. The story cannot supply facts, sources, missing-fact descriptions, classifications or evidence of its own. Unknown fields are refused.

## Story shape

Use the existing route-story object, extended with completeness references:

```js
{
  routeId: 'current',
  headline: 'Your recorded position',
  summary: 'The view follows your confirmed facts.',
  whatifs: [{id: 'incomeStops.primary'}],
  sections: [{
    id: 'current_position',
    title: 'Where you stand',
    parts: {does: 'Words', why: 'Words', gives: '{@position.netWorth}',
            costs: 'Resources assigned here cannot also meet other goals.', check: 'Words'},
    limitationIds: []
  } /* all the remaining sections, in order */]
}
```

All nine sections are required, in this order: `current_position`, `ledger`, `protecting`, `inefficiencies`, `goals`, `cash_flow_after`, `net_worth_after`, `risks`, `check_next`. Every section and every goal subsection has non-empty `does`, `why`, `gives`, `costs`, `check`. Punctuation and invisible text do not count as costs. Preview `paragraphs` are not this contract.

The goals section has `goals: [{goalId, title, parts, limitationIds?}]`, exactly once per goal in the ledger's order. Its own facts must appear in its own subsection. The inefficiencies section has `issues: [issueId]`, with each code-found issue's headline and item facts narrated there. Missing item figures use their code limitations. The cash-flow-after section has `freedCash: [eventId]`, keyed by liability or goal, for every event whose release year falls inside the ledger years; label, amount and release year must appear.

The current-position facts, running cash and surplus at every ledger step, assigned assets, reserve and reserve months, goal states and chosen funding, yearly money after goals and net worth after changes form the section floor. Available figures, registered not-applicable reasons, and code limitations are distinct. A limitation cannot stand in for a result that code has produced.

## What-ifs, risks and major moves

The current adapter recognizes native compiled protection scenarios: `cannotWork` supplies `incomeStops.<personId>` and `dies` supplies `death`. Every earner needs an income-stop illustration; a partner or dependants require a death illustration. A claimed run must be present in the compiled route's protection case, and its gap and savings duration must be narrated in protecting. A metadata tag alone does not meet the floor. An unavailable case needs the code limitation instead. This checker does not run what-ifs, and unknown or unrun what-if IDs are refused; later result adapters must preserve this code-owned evidence boundary.

The risks section has `risks: [{changeIds}]`, tying its visible five parts to the compiled change. Risk prose belongs in the section’s parts, never in metadata the screen would ignore. Each alternative needs a risk citing its main compiled change. Change IDs are `change_<authored index>`; the main change is the major move when present, otherwise the first authored change. B1 alternatives whose funding walk changes without an authored primitive use `goal_funding`. Current needs no change risk. Risk prose still has all five parts.

A section describing a major move includes `majorMoves: [changeId]` beside its costs and check parts. Classification comes from `classifyLever`, including working longer and substantial spending cuts. The story cannot label a move ordinary. At most one major move is allowed unless the **compiled route** has:

```js
majorMoveEvidence: {
  code: 'single_major_insufficient',
  singleMoveRouteIds: ['singleton_a', 'singleton_b']
}
```

Each included major move needs a matching compiled singleton route with the exact same settings and a ledger showing unmet goals. A boolean or a prose claim is not proof. The current compiler already caps routes at one major move; this envelope checks future combined-route evidence without adding a combined-major builder or search.

## Missing results

A limitation records `id`, affected `section` and `result`, `missingFacts` (paths, plain labels and household/plan/implementation kinds), its registered text `key` and code-produced `message`. Missing rates point to their actual debt rate input. Unpriced funding and missing adapters are disclosed without inventing coverage or treating a missing fact as zero.

For each required limitation, list its ID in `limitationIds` and narrate `{limitations.<id>}` both beside the affected result and in `check_next`. Goal subsections can carry their own limitation IDs. The checker returns these records and the requirements reader exposes their facts; the analyst chooses neither the missing-fact names nor the explanation. Author-written “not shown” excuses without the registered reason are refused. These records distinguish missing household facts from unavailable calculation inputs; they do not authorize another follow-up or ask the person to invent an official figure.

## Words and placeholders

Only narration is checked for typed figures; code IDs in metadata may contain digits. Narration uses `{key}`, `{@key}`, `{figure.<register id>}` and `{?explainer.<register id>}`. Unknown markers, braces, unavailable values and other-route facts fail. Figure and explainer IDs come from the pinned register version. Figures use the screen’s dated reader, so a figure not in force on the plan’s calculation date is refused even if it exists in the full register. The checker never substitutes a different rule or rewrites an explainer.

The existing advice, provider and ranking lists apply, with gendered pronouns, typed conclusions and number words refused too. Counts, amounts, rates, ages, years and durations are placeholders, including written-out and Unicode numbers. A story can refer to its own route and current; another alternative's ID, title or a generic comparison is refused. Authored markup and links are refused. These are deterministic checks, not a judgement of sentence quality.

Protection narration can use the income gap, savings duration and stated money received, with the emergency reserve kept in protecting. Total income, cover needs, cover comparisons, premiums, products and providers cannot stand in for those results. An unrelated registered amount cannot be labelled as a payout or cover figure.

## Matching module links

For `{@key}`, code follows the fact's route through `chapterCases`, checks its pointer is inside that exact case, selects its actual `nativeCaseId`, checks versions and finds the real presenter focus target. It replays the relevant native engine from the compiled input with the explicit calculation year, compares the underlying value and unit, and checks the display using the module's formatter and shown result. Cash-flow rounding uses the engine's shown total, which can differ from rounding the exact surplus alone. Current aliases retain current sources. Plan-panel links match the compiled pointer or code calculation.

The existing fact registry now gives chapter sources a null plan-panel target and uses native protection/cash-flow display formatting. It never invents a focus for an undisplayed per-person figure. A missing target, changed case, unequal value or unit, stale version, unsupported exact adapter or mismatched display is a refusal at the story text path. There is no sample lookup, nearest case or silent formatting repair. The current chapter-backed story facts use balance sheet, liquidity, cash flow and protection; a new chapter-backed fact needs its exact native adapter before it can be linked.

`npm run check:story-checker` runs in `check:consumer`. It includes independently authored placeholder stories for the invented renter and borrower, the B1 fixture, a negative case for every rule, native rounding/case/target comparisons, major-move evidence and immutable-input checks. Both authored accepted stories also build and import a complete screen session, including their limitation placeholders. The analyst tool runs this checker before accepting a draft, and `analyst:open` requires a matching passing report.
