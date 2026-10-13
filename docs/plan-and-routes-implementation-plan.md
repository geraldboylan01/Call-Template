# The plan and its routes: implementation plan

Written 13 October 2026 and revised the same evening, when the four decisions in section 4 were settled. This sets the order of work for the next stage of the app: the module screens that are already briefed, and the plan layer that sits over them. It is a plan, not a brief. Each step gets its own brief before it is built, and the plan pack brief (step B0) is the next one to write.

## 1. Where things stand

| Piece | Where | State |
|---|---|---|
| Future cost fund | `main` (PR #55, merged 13 October) | Engine, central cash rate and DIRT built and tested. Screen and wiring not started. |
| Household cash flow | `module/household-cash-flow` | Brief settled (D1 to D7). Nothing built. |
| Goals and resources | `module/goals-and-resources` | Brief and pricing script, amended 13 October (evening) for decisions 1 and 4. Figures provisional until the script is rerun. Engine not built. |
| Protection gap | `module/protection-gap` | Brief settled. Nothing built. The engine may start now; the screen waits for the future cost fund screen. |
| Property decisions | `module/property-decisions` | Brief settled. Nothing built. Not in the first version of the plan. |
| On `main` | | Mortgage, loan, pension, net retirement, college cost, cash reserve and balance sheet engines. The Irish tax engine, now with CGT on property. Household profile v1 with its adapters, module registry and orchestrator. Case packs and the presenter. |

The four module branches hold briefs only. Each brief reaches `main` together with its module's code.

## 2. What the first version does, end to end

1. **An author writes one plan pack.** The author is Claude, in a chat or in Claude Code, so no API is spent. The pack holds the household's facts once, how far each goal could move, and up to three routes beside the current position.
2. **`npm run check:plan-pack` compiles and prices it.** Every chapter's module payload is built from the household facts and the route's changes, every engine runs, and the resource ledger prices each route, taking goals in the planning method's order. The check prints each route's ledger. It fails a route that does not balance, a change outside a goal's stated flexibility, and narration that types a figure.
3. **The app loads the pack like a case pack.** The plan view shows the current position first and the routes beside it, each with its money-now and money-each-year picture and the goals it moves. Picking a route selects the matching case in every chapter. Choosing a different case inside a chapter shows a note that the screen no longer follows the route.
4. **Later, on the website,** an AI analyst writes the same plan pack from the intake, and the same check verifies it before anything runs. The format and the check are the contract, so moving to the API changes who writes the pack, not what the app does with it.

## 3. Rules the code carries

- **One household, one set of facts.** A chapter never states a figure the household already holds, so two chapters cannot disagree.
- **Every euro is counted once.** Money a route puts toward one goal is no longer available to another goal or to any other chapter. This is the resource ledger's "do not double count" rule.
- **Goals are taken in the planning method's order** (section 4, decision 4), never in an order the payload states.
- **Pension money is gross for growth and after relief for cash flow** (section 4, decision 1).
- **A route states what changes, never the result.** The engines solve the amounts.
- **The current position comes first, and it is "nothing changes".** Every other route must balance: cash used is no more than the spare cash, and what the goals need each year is no more than what is left over. A route that does not balance fails the check and is never drawn.
- **Routes are never ranked.** They are ordered by how much they change from the current position and named neutrally. Each says what it changes, above all a goal that moves.
- **Money now and money each year are never drawn on one scale or added together.** As in the method's ledger, alternatives are never totalled: a route picks one way of funding each goal and only that is added up.
- **Narration types no figures.** Every amount in it is a placeholder the ledger fills.
- **Education only.** No "you should", "we recommend", "best", or a product or provider name. The words checks the modules already run apply to every plan screen.

## 4. Decisions, settled 13 October 2026

### 1. Pension money: gross for growth, after relief for cash flow

A contribution counts at its full amount wherever the question is what goes into the pension and how it grows. It counts at its cost after income tax relief wherever the question is what it takes from the household's money. Reviewed module by module:

| Where | Full amount (gross) | Cost after relief |
|---|---|---|
| Pension projection (on `main`) | Pot growth, the relief limit, the extra needed to close a gap | Already shown as the net cost of a contribution. No change. |
| Household cash flow | The Pensions line | Shows as lower tax, so left over moves by the cost after relief. Already how the model works; the assumptions wording is corrected (its D7). Today's contributions become a follow-up (section 5). |
| Goals and resources | The search for the extra contribution | Needed this year, paid out over the life of the goals, and the yearly ledger. **Changed.** In the illustration the extra €15,435 a year saves about €6,174 of income tax, so it costs about €9,300. |
| Resource ledger | The pension chapter's figures | Money each year. |
| Protection gap, future cost fund, property | No pension money | |

The goals and cash flow briefs were amended on their branches.

### 2. The current position is "nothing changes"

Today's repayments, contributions and savings. The ledger shows where each goal lands and how far short it is. The goals module keeps its case 1 ("cash stays as it is") and does not call it the current position. The goals brief records this.

### 3. One pot of cash, counted once

The modules stay separate. This is only about what a plan passes them. In a route, the cash that goes into the mortgage or the college fund is no longer in savings, so the protection chapter for that route measures the months on what is left. With the protection brief's own sample: €60,000 of savings fills a €38,000 yearly gap for 19 months. In a route that puts €40,000 of it into the mortgage, the same €20,000 left lasts about 6 months. Neither module changes; the plan gives each chapter the cash that is actually there in that route. The emergency reserve is never spent by a route, so it is always in the protection chapter's savings.

### 4. Goal order follows the planning method

The resource ledger takes goals in the order the CFP planning method uses (wealth preservation, then removing inefficiencies, then wealth accumulation, shortest horizon first). Nothing in the plan pack or a payload sets the order.

1. **Cash flow first.** A deficit is dealt with before any goal. In the ledger it sits on the "required" side.
2. **Wealth preservation.** The emergency reserve is set aside from cash before anything else. Protection comes next: shown as the gap and the months savings last, never a cover amount, premium or product, so it takes no money in the ledger.
3. **Removing inefficiencies.** Where a route clears an expensive loan from spare cash, that comes before the goals.
4. **Wealth accumulation, soonest first.** Dated costs (each child's college, care for a parent) in order of when they start, then the mortgage, then retirement.

The ledger's assumptions say this order in plain words. The goals module uses the same order, so a goal never reads covered in a chapter and short in the plan. `goalPriorities` is removed from the goals payload, and `goalOrder` is not in the plan pack.

## 5. Gaps the plan exposes in the module briefs

Small changes to modules already briefed, needed before the plan can use them for a real household. None changes a design.

- **Cash flow does not accept today's pension contributions.** Its Stage 1 household pays none. Niamh and Dara pay 5% and 4%. Now in its brief as the first follow-up after the screen lands.
- **The red "short" state.** Cash flow rejects a case that leaves less than nothing (its D3) until the short state is designed, and the goals frames wait for the same state. It must land before the plan view, because routes are compared against a current position that is usually short. One Claude Design task covers both modules.
- **Protection reads cash flow in a plan.** `needed` maps to cash flow's outgoings without tax and pensions (`outgoings.statedTotal`), and `people[].takeHome` to `takeHome.byPerson[].takeHome`, which is marked `allocated` for a jointly assessed couple. `savings` is the cash the route leaves (decision 3). The field names stay as briefed.
- **Goals reads cash flow in a plan.** `leftOverEachYear` becomes cash flow's `summary.cases[].leftOver.amount` for the base case. The goals brief already expects this.
- **Each brief has its own sample household.** The golden plan pack is the first time every chapter sees one household (Niamh and Dara), so its figures will differ from every brief's sample. That is expected, not a defect.

## 6. What the app collects, and what a plan needs

**For the module screens, nothing new.** In Stage 1 they are adviser-only and their inputs are typed into the Dev Panel or a case pack, as the pension and mortgage modules were at first.

**For a plan built from the household profile**, most of what is needed is already collected: each person, their age and income (gross, and net where given), pension pots and contribution rates, retirement age and target income, the State Pension fraction, the mortgage and loans (balance, rate, term, monthly payment), cash, children's ages and college plans, and essential spending.

Missing, and needed before a plan can run from the profile alone:

| Gap | Why it matters | Where it goes |
|---|---|---|
| Total spending, not only essentials | The app asks essential spending excluding housing debt, which is right for the cash reserve. Left over each year needs everything spent, or it is overstated. | A question, `expenses.annualTotal` already exists in the profile |
| Married or civil partners, or not | Decides joint assessment, which changes take-home a lot. The profile has no field for it; only the pension payload carries it. | A new profile field and question |
| When the mortgage should be cleared | The mortgage goal needs an age. | A goal target date, which the profile already holds; nothing asks for it yet |
| How far each goal could move | Routes may only move a goal within what the client said is possible (a later retirement, a lower target, a longer mortgage). | A question per goal, kept in the plan pack |
| Other dated costs | Care for a parent or school fees need a start, a number of years and a yearly cost. | Goal target date and amount exist; the number of years does not |
| State payments if an income stops | Illness, invalidity and survivor's payments. | Central assumptions with their sources, not questions |
| Whether the mortgage would be cleared on a death | The protection chapter's need after a death depends on it. | A question |
| Property (later) | Rent, running costs, purchase date and price, how it was acquired, whether it was ever a home. | Questions, when property joins the plan |

In the hand-authored version the author writes these straight into the plan pack's household, so B0 and B1 can start now. The profile fields arrive with the adapters (B2), and the consumer questions before the website version.

## 7. The order of work

Two tracks run side by side. Track A builds the module screens, one Claude Code chat per module as now. Track B builds the plan layer in one new chat. Design tasks sit between them.

| Step | What | Waits for | Who |
|---|---|---|---|
| D1 | The red "short" state for cash flow and goals | | Claude Design |
| A1 | Future cost fund screen and wiring. It sets the wiring pattern the other modules copy. | | Future cost fund chat |
| A2 | Household cash flow engine now; its screen after A1; then today's pension contributions; then lifting the D3 rejection after D1 | A1 for wiring, D1 for the lift | Cash flow chat |
| A3 | Protection gap engine now; its screen after A1 | A1 for the screen | Protection chat |
| A4 | Goals and resources: merge `main`, apply the 13 October changes, rerun the script; then the engine; then the screen | D1 for the screen | Goals chat |
| P | Prompt pack entries for each module, from its contract summary (section 8) | Each module merged | Claude |
| B0 | Plan pack v1: format, validator, compiler for the modules on `main`, and `check:plan-pack` | | Plan chat |
| B1 | The resource ledger: resources available and required, goal states in the method's order, the balance test, route order and what each route changes | B0 and the A4 engine. Left over is stated until A2 lands. | Plan chat |
| B2 | Adapters from the household profile for cash flow, protection gap, future cost fund and goals, with the profile fields from section 6 | Each module's engine | Plan chat |
| D2 | The plan view: the current position and the routes side by side | B1's output shape | Claude Design |
| B3 | The plan view built, route-to-case selection, the "not following the route" note, presenter beats | D2, B1, B2 | Plan chat |
| B4 | The plan playbook (how an author writes a plan pack) and two golden plan packs | B1 | Gerry and Claude |
| Later | Property chapters as routes, where a sale's proceeds become money now. The consumer questions from section 6. The website version through the API. | B3 | |

B0 can start now, in parallel with A1 to A4, because it needs only engines already on `main` and a stated left-over figure. That is the reason to keep the plan work in its own chat rather than in a module chat.

The module screens stay adviser-only (`consumer: false`) as their briefs say. The plan view starts the same way.

## 8. The prompt pack

Every new module needs its place in `docs/prompt-pack/`, so an author can write its payload from a call: a playbook, its spoken names in `01_playbook_aliases.md`, its row in `02_schema_capability_matrix.md`, the assembled `MASTER_PROJECT_PROMPT.md`, and examples in `90_` and `91_`. The plan adds one more playbook, for writing a plan pack; that is B4.

- **When:** after each module's code is merged, never before, so the playbook describes what the code does. Each brief ends with a "contract summary for the prompt pack" for exactly this.
- **Who:** Claude, one pull request per module. No app code changes.
- **The module chats do not touch `docs/prompt-pack/`.** Their briefs already say so.
- **Consumer routing stays off.** Playbooks carry a `planeir-planning-module` marker that feeds `js/planning/playbook_manifest.generated.js`. A new module's playbook leaves that marker out until the module has a registry entry and an adapter (B2), so the consumer pipeline never routes to a module it cannot run.

Order, by when each module lands: future cost fund first, then household cash flow, protection gap, goals and resources, and the two property modules.

## 9. The plan pack and the ledger, in outline

The B0 and B1 briefs set these out in full. The shape, for review:

```json
{
  "planPackVersion": 1,
  "clientName": "Niamh and Dara",
  "calculationDate": "2026-11-01",
  "household": { "note": "a household profile v1: the facts, once" },
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
- **The ledger is built the way the method builds it.** Resources available on one side: spare cash (cash less the emergency reserve), investments not tied to a goal, and left over each year. Resources required on the other: each goal's ways of being funded (a lump sum now, or an amount each year). Anything already used by a goal, such as a pension pot for retirement, is crossed off and never used again.
- **What the check prints for each route:** what is available; what each goal takes, in the method's order, with pension money after relief; each goal's state; the cash left and the months it would last if an income stopped; left over each year after the route; and what the route changes against the current position.

## 10. Next

1. Paste the replies into the four module chats (future cost fund, cash flow, protection, goals). Property waits for the future cost fund screen.
2. Claude writes the B0 brief (plan pack v1) for a new plan chat, and the Claude Design prompt for the red "short" state.
3. Claude adds the future cost fund to the prompt pack once its screen merges.
