# The plan and its routes: implementation plan

Written 13 October 2026. This sets the order of work for the next stage of the app: the module screens that are already briefed, and the plan layer that sits over them. It is a plan, not a brief. Each step gets its own brief before it is built, and the plan pack brief (step B0) is the next one to write.

## 1. Where things stand

| Piece | Where | State |
|---|---|---|
| Future cost fund | PR #55, `module/future-cost-fund` | Engine, central cash rate and DIRT built and tested. Screen and wiring not started. |
| Household cash flow | `module/household-cash-flow` | Brief settled (D1 to D6). Nothing built. |
| Goals and resources | `module/goals-and-resources` | Brief and pricing script. Figures provisional until PR #55 is on `main`. Engine not built. |
| Protection gap | `module/protection-gap` | Brief settled. Nothing built. Waits for the future cost fund screen. |
| Property decisions | `module/property-decisions` | Brief settled. Nothing built. Not in the first version of the plan. |
| On `main` | | Mortgage, loan, pension, net retirement, college cost, cash reserve and balance sheet engines. The Irish tax engine, now with CGT on property. Household profile v1 with its adapters, module registry and orchestrator. Case packs and the presenter. |

Only PR #55 needs merging now. The other four branches hold briefs only, and each brief reaches `main` together with its module's code.

## 2. What the first version does, end to end

1. **An author writes one plan pack.** The author is Claude, in a chat or in Claude Code, so no API is spent. The pack holds the household's facts once, the goals in the client's order, how far each goal could move, and up to three routes beside the current position.
2. **`npm run check:plan-pack` compiles and prices it.** Every chapter's module payload is built from the household facts and the route's changes, every engine runs, and the resource ledger prices each route. The check prints each route's ledger. It fails a route that does not balance, a change outside a goal's stated flexibility, and narration that types a figure.
3. **The app loads the pack like a case pack.** The plan view shows the current position first and the routes beside it, each with its money-now and money-each-year picture and the goals it moves. Picking a route selects the matching case in every chapter. Choosing a different case inside a chapter shows a note that the screen no longer follows the route.
4. **Later, on the website,** an AI analyst writes the same plan pack from the intake, and the same check verifies it before anything runs. The format and the check are the contract, so moving to the API changes who writes the pack, not what the app does with it.

## 3. Rules the code carries

- **One household, one set of facts.** A chapter never states a figure the household already holds, so two chapters cannot disagree.
- **A route states what changes, never the result.** The engines solve the amounts.
- **The current position comes first.** Every other route must balance: cash used is no more than the spare cash, and what the goals need each year is no more than what is left over. A route that does not balance fails the check and is never drawn.
- **Routes are never ranked.** They are ordered by how much they change from the current position and named neutrally. Each says what it changes, above all a goal that moves.
- **Money now and money each year are never drawn on one scale or added together.**
- **Narration types no figures.** Every amount in it is a placeholder the ledger fills.
- **Education only.** No "you should", "we recommend", "best", or a product or provider name. The words checks the modules already run apply to every plan screen.

## 4. Four decisions before the plan code

1. **Pension money after tax relief.** The goals script counts extra pension contributions before relief (€15,442 a year in its illustration) against left-over money that is after tax. The cash flow brief counts the cost after relief (€10,000 paid in costs €6,000). One ledger cannot do both. **Proposed:** count every pension contribution after relief, using the tax engine, in the goals engine and in the ledger. Checked with the tax engine on `main` for the illustrative household: about €15,400 a year of extra contributions saves about €6,200 of income tax, so it costs about €9,300 a year. Every goals figure that includes it moves.
2. **What "current position" means.** **Proposed:** nothing changes (today's repayments, contributions and savings), and the ledger shows where each goal lands and how far short it is. The goals module's case 1 ("cash stays as it is, every goal still pursued from yearly money") then becomes the first route that changes something. This also settles open item 1 in the goals brief.
3. **Savings in the protection chapter follow the route.** **Proposed:** the months savings last are measured on the cash a route leaves, which is the reserve plus any spare cash it does not use. A route that puts cash into the mortgage shows that cost in months. This is the main thing the ledger shows that no single module can.
4. **The goal order comes from the plan pack.** Profile goals carry high, medium or low, which allows ties. **Proposed:** the pack states a strict order, and the profile's priority is only where the author starts. This settles open item 4 in the goals brief.

## 5. Gaps the plan exposes in the module briefs

Small changes to modules already briefed, needed before the plan can use them for a real household. None changes a design.

- **Cash flow does not accept today's pension contributions.** Its Stage 1 household pays none, and an `employmentPensionContribution` in `income` is rejected. Niamh and Dara pay 5% and 4%. The plan needs a person's current contribution, with tax and take-home following it. Proposed as the first follow-up once the cash flow screen lands.
- **The red "short" state.** Cash flow rejects a case that leaves less than nothing (its D3) until the short state is designed, and the goals frames wait for the same state. It must land before the plan view, because routes are compared against a current position that is usually short. One Claude Design task covers both modules.
- **Protection reads cash flow in a plan.** `needed` maps to cash flow's outgoings without tax and pensions (`outgoings.statedTotal`), and `people[].takeHome` to `takeHome.byPerson[].takeHome`, which is marked `allocated` for a jointly assessed couple. The protection footnote already says take-home may differ. The adapter records the mapping, and the field names stay as briefed.
- **Goals reads cash flow in a plan.** `leftOverEachYear` becomes cash flow's `summary.cases[].leftOver.amount` for the base case. The goals brief already expects this.
- **Each brief has its own sample household.** The golden plan pack is the first time every chapter sees one household (Niamh and Dara), so its figures will differ from every brief's sample. That is expected, not a defect.

## 6. The order of work

Two tracks run side by side. Track A builds the module screens, one Claude Code chat per module as now. Track B builds the plan layer in one new chat. Design tasks sit between them.

| Step | What | Waits for | Who |
|---|---|---|---|
| 0 | Merge PR #55. The goals chat merges `main` into its branch and reruns the script. | | Gerry, then the goals chat |
| D1 | The red "short" state for cash flow and goals | | Claude Design |
| A1 | Future cost fund screen and wiring. It sets the wiring pattern the other modules copy. | 0 | Future cost fund chat |
| A2 | Household cash flow engine and screen, then today's pension contributions, then lifting the D3 rejection | A1 for wiring, D1 for the lift | Cash flow chat |
| A3 | Protection gap engine and screen | A1 | Protection chat |
| A4 | Goals and resources engine (the script moved into `js/goals_and_resources_math.js`, with decision 1), then its screen | 0 and decision 1; D1 for the screen | Goals chat |
| B0 | Plan pack v1: format, validator, compiler for the modules on `main`, and `check:plan-pack` | 0, decisions 2 and 4 | Plan chat |
| B1 | The resource ledger: money now, money each year, goal states, the balance test, route order and what each route changes | B0 and the A4 engine. Left over is stated until A2 lands. | Plan chat |
| B2 | Adapters from the household profile for cash flow, protection gap, future cost fund and goals | Each module's engine | Plan chat |
| D2 | The plan view: the current position and the routes side by side | B1's output shape | Claude Design |
| B3 | The plan view built, route-to-case selection, the "not following the route" note, presenter beats | D2, B1, B2 | Plan chat |
| B4 | The authoring guide (the instructions an author follows to write a plan pack) and two golden plan packs | B1 | Gerry and Claude |
| Later | Property chapters as routes, where a sale's proceeds become money now. The website version through the API. | B3 | |

B0 can start the day PR #55 merges, in parallel with A1 to A4, because it needs only engines already on `main` and a stated left-over figure. That is the reason to keep the plan work in its own chat rather than in a module chat.

The module screens stay adviser-only (`consumer: false`) as their briefs say. The plan view starts the same way.

## 7. The plan pack, in outline

The B0 brief sets this out in full. The shape, for review:

```json
{
  "planPackVersion": 1,
  "clientName": "Niamh and Dara",
  "calculationDate": "2026-11-01",
  "household": { "note": "a household profile v1: the facts, once" },
  "goalOrder": ["goal_college", "goal_mortgage", "goal_retirement"],
  "goalFlexibility": {
    "goal_retirement": { "retirementAge": [62, 65], "targetIncomeToday": [46000, 50000] },
    "goal_mortgage": { "clearByAge": [60, 63] }
  },
  "routes": [
    { "id": "current" },
    {
      "id": "route-2",
      "changes": [
        { "type": "useCash", "goalId": "goal_college", "amount": "whole" },
        { "type": "moveGoal", "goalId": "goal_retirement", "retirementAge": 65, "targetIncomeToday": 46000 }
      ]
    }
  ],
  "chapters": [
    "household_cash_flow", "liquidity_analysis", "protection_gap",
    "mortgage_analysis", "future_cost_fund", "pension_projection"
  ],
  "narration": { "route-2": "Placeholders only, for example {route.goalsMoved}." }
}
```

- **Up to four routes, the current position included.** Each chapter gets one case per distinct setting across the routes, so every chapter fits the four-case cap without a new rule.
- **Change types in the first version:** use cash on a goal (an amount, the whole goal, or what is left), move a goal (an age or a target within its stated flexibility), and clear an outgoing from savings. Anything else is rejected until it is designed.
- **The emergency reserve is never spent by a route.** Spare cash is cash less the reserve the cash reserve engine sets.
- **Protection is a chapter, not a goal.** It does not take money in the ledger. It shows how long the cash a route leaves would last if an income stopped.
- **What the check prints for each route:** spare cash and what each goal takes from it; left over each year and what each goal needs, after tax relief; each goal's state in the client's order; the months savings last if an income stops; and what the route changes against the current position.

## 8. Next

- Merge PR #55.
- Settle the four decisions in section 4.
- Then: the B0 brief (plan pack v1), the Claude Design prompt for the short state, and replies for the goals and future cost fund chats.
