# The plan and its routes: implementation plan

Written 13 October 2026, with the four decisions in section 4 settled that evening. Status refreshed 16 October 2026 after #72 merged. This sets the order of work for the module screens and the plan layer over them. It is a plan, not a brief. Each step gets its own brief before it is built; the plan-pack brief (B0) is next.

## 1. Where things stand

| Piece | Where | State |
|---|---|---|
| Future cost fund | `main` (#55 and #57) | Engine, screen, wiring, central cash rate and DIRT built and tested. Prompt-pack entry merged. |
| Household cash flow | Engine, screen and wiring on `main`; short-state changes in #71 | #71 includes bounded charts, the negative-tax fix and phone layout checked with #72. Fresh review and CI precede its merge. Today's pension contributions remain a separate follow-up. |
| Goals and resources | Engine on `main` (#58, #67, #70); timeline fields in #75; screen in draft #76 | Engine and earnings-cap fixes built. #75 adds year offsets and calendar-year ledger labels. #76 implements Proposal A, but app wiring and conditional relief footnotes remain to be finished. |
| Protection gap | `main` (#61, #65); zero-payment extension in #77 | Engine, screen, wiring and prompt-pack entry built. #77 allows a confirmed €0 State payment and records sourced Irish payment references. Entitlement is not inferred from a maximum rate. |
| Property decisions | Rental on `main` (#64, #66); home trade down on `main` (#72) | Both modules built and wired. Shared phone grids also include #73. Property chapters remain outside the first version of the plan. |
| On `main` | | Mortgage, loan, pension, net retirement, college cost, cash reserve and balance sheet engines. The Irish tax engine, now with CGT on property. Household profile v1 with its adapters, module registry and orchestrator. Case packs and the presenter. |

Module briefs accompany the code. Open-PR references above are a dated snapshot, not additional dependencies on the B0 brief. Prompt-pack entries for cash flow and home trade down follow their final merged contracts; the protection-gap zero-payment entry follows #77.

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
- **The red "short" state.** Designed and implemented in #71, including signed summary figures, a status based on the shown amount, bounded chart geometry and the narrow phone layout. Its merge is required before the plan view uses a short current position. No new design task is needed for that state.
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
| D1 | Red "short" state designed; cash flow implementation in #71 and goals drawing in #76 | Merge #71; finish goals integration | Module work |
| A1 | Future cost fund screen and wiring complete on `main`; its updated wiring list remains the pattern | Complete | Future cost fund module |
| A2 | Cash flow engine, screen and wiring complete; merge #71, then add today's pension contributions in its own change | Clean final review and CI for #71; contribution input contract | Cash flow module |
| A3 | Protection gap complete; confirmed zero-payment extension in #77 | Clean review and CI for #77 | Protection module |
| A4 | Goals engine complete; merge #75, retarget #76 to `main`, finish app wiring and conditional relief footnotes, then review the screen | #75 for timeline fields; screen wiring checks | Goals module |
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

Already merged: future cost fund, protection gap and rental keep or sell. Next: household cash flow and home trade down once #71 and #72 are merged, plus the protection-gap zero-payment contract after #77. Goals and resources follows the finished screen integration. Keep documentation updates separate from module-code changes.

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

1. Complete the remaining module reviews and merges above. Keep the pension-contribution input contract and goals wiring as explicit follow-ups.
2. Write the B0 brief for plan pack v1: its format, validator, module compiler and `check:plan-pack`. This can proceed in parallel with module integration using the engines already on `main`.
3. Add prompt-pack entries from final merged module contracts. B1 supplies the resource ledger; B2 adds profile adapters; B3 supplies the route-linked plan view. None is implied to be built by merging this plan.
