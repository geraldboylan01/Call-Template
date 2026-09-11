# Scenario Cap - App Changes Required

The prompt pack now allows **up to 4 cases per module, counting the base or current case**.
PBS therefore allows `Current position` plus a maximum of 3 alternatives.

The prompt-pack side is done. This file lists the app work that has to follow, in order.
Item 1 is blocking: the repo's own sync check fails until it is run.

Prompt-pack files already changed:
`00_core_contract.md`, `01_playbook_aliases.md`, `02_schema_capability_matrix.md`,
`10_pbs_playbook.md`, `11_retirement_playbook.md`, `14_college_funding_playbook.md`,
`15_net_retirement_cashflow_playbook.md`, `90_examples_and_regression_prompts.md`,
`91_artifact_payload_examples.md`, `README_PROMPT_PACK.md`, `MASTER_PROJECT_PROMPT.md`.

---

## 1. Regenerate the planning playbook manifest (blocking)

`js/planning/playbook_manifest.generated.js` embeds the full text of every
`docs/prompt-pack/NN_*_playbook.md` file in `PLANNING_PLAYBOOK_GUIDANCE`. Four of those
files changed, so the generated manifest is stale and `npm run check:planning-playbooks`
currently throws `Generated planning playbook manifest is stale.`

```
npm run generate:planning-playbooks
npm run check:planning-playbooks
```

Commit the regenerated `js/planning/playbook_manifest.generated.js`.
`dist/` is untracked build output, so a later `npm run build` covers it; nothing to commit there.

## 2. Enforce the 4-case cap in the engine normalisers (hard reject)

Over-limit payloads must fail to apply with a clear message naming the module and the
count, rather than silently rendering a partial set. Each of these functions already
throws for bad shapes and duplicate ids, so follow the existing message style:
`generated.<key>.scenarios supports at most N cases; received M.`

| File | Function | Limit |
|---|---|---|
| `js/app.js` | `validateOutputsBucketedScenariosPayload` (~7016) | 3 alternatives |
| `js/pension_math.js` | `normalizeRentalIncomeScenarios` (~88) | 4 cases |
| `js/net_retirement_math.js` | `normalizeScenarios` (~255) | 4 cases |
| `js/college_funding_math.js` | scenario normaliser (~400) | 4 cases |

Two extra rules for PBS, which is the one path with neither check today:

- Reject duplicate `scenario.id` values, the way the other three engines already do.
  A repeated id breaks case selection in `getPbsScenarioCases`.
- Keep the error text about alternatives, not total cases, so the number in the message
  matches what the payload actually contains: "at most 3 alternatives" rather than "4 cases".

For college funding, also reject a payload that sends both the at-home / away shorthand
(`atHomeAnnualCostTodayPerChild` and friends) **and** an explicit `scenarios` array, since
the shorthand already expands to four standard scenarios and the pair would exceed the cap.

## 3. Cap defensively on the session import path (do not throw)

`js/state.js` keeps its own private normalisers used when an already published session is
imported: `normalizeOutputsBucketedScenarios` (~950), the `rentalIncomeScenarios` block
in `normalizePbsInputs`/pension normalisation (~1105), and the college scenarios block
(~725). Throwing there would break a client link that was published before the cap existed.

Keep the first N cases, drop the rest, and push a string into the existing warnings channel.
Reject on the way in, tolerate on the way back out.

## 4. Let the case switcher hold 4 to 5 buttons

`styles/base.css`:

- `.pbs-scenario-options` (~1460) and `.pension-scenario-options` (~1550) use
  `grid-auto-flow: column` with `grid-auto-columns: minmax(132px, auto)`. That pins every
  case to one row, so four or five buttons need 660px+ and overflow the card at normal
  widths. Switch to a wrapping grid, e.g.
  `grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));` with row flow.
- `.pbs-scenario-switcher` (~1438) is a flex row with the `Case` label beside the options.
  Add `flex-wrap: wrap` and `align-items: flex-start` so a two-row grid sits correctly
  beside the label.
- The mobile overrides at ~3184-3230 already stack to one column. Leave them.
- `.retirement-scenario-options` (~1261) already uses `auto-fit minmax(220px, 1fr)` and
  wraps correctly. No change.

Check it at 3, 4 and 5 cases with long titles such as `Sell Rental, Fund Pension`.

## 5. Animate scenario-to-scenario transitions in PBS

`js/render.js` `getPbsTransitionMovementConfig` (~6826) returns movements only for
`Current position -> alternative` and `alternative -> Current position`. Every other
transition returns `{ movements: [], reverse: false }` and the client sees only the
content highlight.

With one alternative that was rare. With three it is the common click.

Fix by composing the reverse of `previousCase.movements` with the forward
`nextCase.movements` when both cases are alternatives, so the value visibly returns to the
current position and then moves out again. `buildPbsScenarioMovementPlan` already handles a
`reverse` flag per movement list, so the work is in combining two plans rather than in the
animation itself.

Lower priority than 1 to 4, but this is the one Gerry notices live.

## 6. Tests

Add to the existing checks rather than a new harness:

- PBS payload validation: a 3-alternative payload applies cleanly; a 4-alternative payload
  throws; two alternatives sharing an id throws.
- Each engine normaliser: a 4-case payload normalises; a 5-case payload throws.
- College funding: shorthand plus explicit `scenarios` throws.
- Session import: a published session carrying 5 cases imports with 4 cases and a warning,
  and does not throw.

`docs/prompt-pack/91_artifact_payload_examples.md` now carries a worked PBS payload with
three alternatives, every one of which reconciles independently to the same net worth. It
is a ready-made fixture.

Then run at minimum:

```
npm run check:planning-playbooks
npm run check:module-manifest
npm run check:consumer-personal-balance-sheet
npm run check:consumer-session-payload
```

## 7. Do not change

- The six-section PBS contract, the exact `Net worth` row and subtotal labels, or the
  movement action vocabulary (`add`, `reduce`, `increase`, `remove`).
- House Purchase. Its contract is `summaryHtml` plus `housePurchaseInputs` only, and its
  support cases (`none`, `htb_only`, `fhs_only`, `htb_and_fhs`) are local, non-persisting
  runtime state, not a scenario array.
- Liquidity, Mortgage, Loan, Education and Protection. They have no scenario array.
