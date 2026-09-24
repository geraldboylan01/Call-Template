# Retirement cases that change retirement age and contributions

## Context

Call Canvas renders the Retirement module from `generated.pensionInputs`, calculated by `computePensionProjection` in `js/pension_math.js`. The module can already switch between up to 4 cases, but a case can only change one thing: gross rental income. Those cases live in `generated.pensionInputs.rentalIncomeScenarios[]` (`id`, `title`, `rentalIncomeToday`), `baseScenarioId` picks the opening case, and `resolvePensionScenario` feeds the chosen rent into the projection.

The questions clients ask most are about timing and contributions: retire at 58 or 62, stop now or keep contracting to 60, go part-time at 60, pay in 10% instead of 5%. Today each of those needs a separate module, so the client can't flip between them on one screen. This change lets a Retirement case change retirement age, contributions and other income as well as rent.

## Before you write code

- Pull `main` and create a new branch, for example `retirement-cases`. The checked-out `pbs-module-layout` branch is already merged into main.
- Read `js/pension_math.js`, the pension parts of `js/state.js`, `js/app.js` and `js/render.js` (search for `rentalIncomeScenarios`, `pensionScenarioId`, `buildRetirementScenarioOptions`, `buildRetirementDecisionPanel`), plus `js/scenario_cap.js`, `js/video_scene.js`, `js/codex_video_brief.js` and `js/tests_pension_math.js`. Also read how `js/mortgage_math.js` handles `mortgageInputs.scenarios`, because this should follow the same pattern.
- Then give me a short plan: final field names, the override list, and how timing fields are re-derived per case. Wait for my go-ahead before implementing.

## The contract

Add `generated.pensionInputs.scenarios[]`. Like mortgage cases, a case restates only what it changes and inherits everything else from the base inputs.

Each case has:

- `id`: required, unique within the module.
- `title`: required and client-facing, e.g. `Retire at 58`, `Keep contracting to 60`, `Pay in 10%`.
- `description`: optional, one sentence.

Allowed overrides:

- Household: `rentalIncomeToday`, `targetIncomeToday`, `targetIncomePctOfSalary`, `excludedIncomeSourceIds` (ids from the base `otherIncomeSources`), `additionalIncomeSources` (same shape and validation as `otherIncomeSources`, for things like part-time or contracting income over a set age range).
- Single-person payloads (no `pensions[]`): `retirementAge`, `personalPct`, `employerPct`, `currentPot`, `includeStatePension`.
- Couple payloads (with `pensions[]`): `pensionOverrides: [{ "id": "<member id>", ...fields }]` where the fields can be `retirementAge`, `personalPct`, `employerPct`, `currentPot`, `includeStatePension`. Every entry must name an existing member id.
- Timing, optional: `incomeStartYear`, `targetStartYear` or `targetStartAge`, `requiredPotReferenceYear`, `includeEmploymentIncomeDuringBridge`.

`currentPot` replaces the member's pot. A one-off top-up is written as the new total.

Rules:

1. At most `MAX_MODULE_SCENARIO_CASES` (4) cases, base included, using the shared constant in `js/scenario_cap.js`. Over the cap, a duplicate id, an unknown member id, or an unknown override key is rejected, in the style of the existing messages: `generated.pensionInputs.scenarios supports at most 4 cases; received 5.`
2. `baseScenarioId` must match a case id when `scenarios` is present. It is the opening case and the one the others are compared against.
3. Timing is re-derived per case. When a case changes any member's retirement age, that case's `incomeStartYear`, `targetStartYear`, `requiredPotReferenceYear` and bridge-income default are derived from the case's own retirement ages, exactly as a standalone payload with those ages would derive them, unless the case restates them. Timing values set explicitly on the base never carry into a case that changes a retirement age.
4. Anything keyed to the retirement year, such as the SFT check and ARF minimum withdrawals, follows the case's own retirement year.
5. Every case is a complete projection. For every case, the result must be identical to the result of a standalone payload built by applying that case's overrides to the base inputs (with timing re-derived under rule 3). Make this a test that runs over every case in every fixture.
6. Each merged case must pass `normalizePensionInputs`, and errors name the case: `generated.pensionInputs.scenarios[1] (Retire at 58): retirementAge must be greater than currentAge.`
7. Cases work the same in target and affordable mode.
8. `rentalIncomeScenarios` keeps working exactly as today, for existing sessions and the current prompt pack. Internally it can become rent-only cases on the new path. A payload with both `scenarios` and `rentalIncomeScenarios` is rejected with an error saying to use one or the other.
9. The session importer in `js/state.js` treats `scenarios` like the other capped arrays: tolerate on the way in, cap with an import warning, never throw.
10. No growth-rate or inflation overrides. Those are sensitivities rather than client decisions, and stay out of scope.

## On screen

- The case cards in the retirement decision panel say in plain words what each case changes (e.g. `Retire at 58` with a detail line such as `Contributions stop at 58, income from 2034`). Rent-only cases read as they do today.
- Keep the chart x-axis the same for every case (the union of the case ranges), so switching case moves the retirement point and the balance line instead of rescaling the axis. The client should be able to read the difference straight off the chart.
- The readiness wording the runtime appends (on track, short, surplus) reflects the selected case.
- Inline assumption edits: with a non-base case selected, editing a field that case overrides edits the case, the way `rentalIncomeToday` edits already work in `js/app.js`. With the base case selected, edits go to the base.
- `js/video_scene.js` and `js/codex_video_brief.js` resolve the selected case with its overrides, so a video of the module shows that case's ages and figures.
- Add a Dev Panel example payload with a single-person retirement-age comparison (three cases) beside the existing retirement examples.

## Tests

Extend `js/tests_pension_math.js`, and the check scripts that already cover pension cases, with at least:

- Single person, cases retiring at 58, 62 and 66: each case equals its standalone payload on every output figure.
- Couple with staggered retirement, one case moving one member's age: timing re-derived, bridge income correct, equal to standalone.
- A contributions case (personal 5% to 10%), a `currentPot` top-up case, and a part-time income case using `additionalIncomeSources`.
- A case that changes both rent and retirement age.
- Rejections with the exact messages: fifth case, duplicate id, unknown member id, unknown override key, both arrays present, invalid age inside a case.
- Every existing `rentalIncomeScenarios` test unchanged and passing.

`runPensionMathTests()` currently only runs from `js/app.js`. Add an npm script (e.g. `test:pension`) that runs it in Node and exits non-zero on failure.

Before finishing, run `npm run build`, the new pension test script, and `check:pension-projection-audit`, `check:video-scene`, `check:codex-video-brief` and `check:consumer-session-payload`.

## Out of scope

- Do not edit anything in `docs/prompt-pack/`. The retirement playbook, master prompt and schema matrix get updated separately once this lands, so they describe what the code actually does.
- No changes to other modules, the consumer planning path, default assumptions, or the State Pension rate.

## When you finish

End with a contract summary for the prompt pack: field names, the full override list, the inheritance and re-derivation rules, every validation error string, and the example payload. Keep to the repo's commit style: short plain-English commits describing what the client sees change.
