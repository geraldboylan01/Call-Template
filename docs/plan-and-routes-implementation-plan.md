# The plan and its routes: implementation plan

Written 13 October 2026, with the four decisions in section 4 settled that evening. Status refreshed 20 October 2026; the central illness-scenario assumption was approved on 17 October. This sets the order of work for the module screens and the plan layer over them. It is a plan, not a brief. Each step gets its own brief before it is built. B0 merged in #80 and B1 in #85, against the [v1 contract](plan-pack-v1.md) and [B1 brief](plan-pack-b1-brief.md). B1.1 (freed cash and retirement) is in #87. The [B1.5 storyteller brief](plan-pack-b15-story-brief.md) is written for review and comes before the plan view design.

## 1. Where things stand

| Piece | Where | State |
|---|---|---|
| Future cost fund | `main` (#55 and #57) | Engine, screen, wiring, central cash rate and DIRT built and tested. Prompt-pack entry merged. |
| Household cash flow | `main` (#71, #82, #83) | Bounded short-state charts and phone layout merged. Today's contributions and their app/prompt contracts are merged; stated take-home is bank pay after the personal pension deduction. |
| Goals and resources | `main` (#58, #67, #70, #75, #76) | Engine, calendar-year wording, Proposal A screen, app wiring and conditional relief footnotes merged. |
| Protection gap | `main` (#61, #65, #77) | Engine, screen, wiring and prompt-pack entry built. Confirmed €0 State payments and sourced Irish payment references merged. The approved central assumption for hypothetical illness scenarios is specified below; its adapter and tax support remain to be built. |
| Property decisions | Rental on `main` (#64, #66); home trade down on `main` (#72) | Both modules built and wired. Shared phone grids also include #73. Property chapters remain outside the first version of the plan. |
| On `main` | | Mortgage, loan, pension, net retirement, college cost, cash reserve and balance sheet engines. The Irish tax engine, now with CGT on property. Household profile v1 with its adapters, module registry and orchestrator. Case packs and the presenter. |

Module briefs accompany the code. The module follow-ups above are merged. #83 includes the final cash-flow and home-trade-down prompt contracts. B0 uses those engine contracts without changing consumer activation.

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
| Household cash flow | The Pensions line | Shows as lower tax, so left over moves by the cost after relief. Already how the model works; the assumptions wording is corrected (its D7). Today's contributions are included after #82; bank take-home is after the personal deduction. |
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

- **Today's pension contributions are implemented.** #82/#83 accept each person's current personal contribution and state that bank take-home is after that deduction. Niamh and Dara's 5% and 4% rates must not be deducted from stated bank pay twice.
- **The red "short" state.** Designed and implemented in #71, including signed summary figures, a status based on the shown amount, bounded chart geometry and the narrow phone layout. It is merged, so the plan layer can use a short current position. No new design task is needed for that state.
- **Protection reads cash flow in a plan.** `needed` maps to cash flow's outgoings without tax and pensions (`outgoings.statedTotal`), and `people[].takeHome` to `takeHome.byPerson[].bankTakeHome`, which is marked `allocated` for a jointly assessed couple. `savings` is the cash the route leaves (decision 3). The field names stay as briefed.
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
| State payment in a hypothetical illness scenario | Standard personal Illness Benefit rate for an employed person assumed to qualify. | A central, sourced, dated planning assumption; never a question asking the client to predict an entitlement. See the contract below. |
| Survivor's payment after a death | A separate scenario with different eligibility and tax treatment. | Keep the existing stated-input contract until its own assumption is designed; the illness default does not select a survivor's payment. |
| Whether the mortgage would be cleared on a death | The protection chapter's need after a death depends on it. | A question |
| Property (later) | Rent, running costs, purchase date and price, how it was acquired, whether it was ever a home. | Questions, when property joins the plan |

In the hand-authored version the author writes these straight into the plan pack's household, so B0 and B1 can start now. The profile fields arrive with the adapters (B2), and the consumer questions before the website version.

### Approved illness-scenario assumption

The form collects current household facts. It must not ask what disability payment someone would receive in a hypothetical future illness. For the standard scenario, assume an employed person becomes unable to work, their employer sick pay has ended, and they qualify for the standard personal rate of **Illness Benefit**. This is an illustrative assumption, not an award or a finding of eligibility. Use one personal rate, without dependent increases. The employee assumption must not silently be applied to self-employment or retirement; use the employment facts already collected to identify its scope, without building a benefits questionnaire.

Keep the rate in the central planning assumptions, with the scheme, weekly amount, source, checked date, effective dates, approval status and version. The [Department's scheme page](https://www.gov.ie/en/service/ddf6e3-illness-benefit/) gives a 2026 maximum personal rate of €254 weekly, or €13,208 for a 52-week illustration. [Budget 2027](https://prelive.oireachtas.ie/en/debates/debate/dail/2026-10-06/3/) announces a €10 weekly increase: €264, or €13,728 over 52 weeks, is the derived future reference. Keep it separate from the rate currently payable; verify the scheme's commencement before activation. Do not add the separate cost-of-disability lump sum to recurring illness income.

Each Budget update reviews the official scheme rates, dates and conditions, adds a versioned record and checks dates immediately before and after commencement. Use the applicable approved record for a new calculation. Retain the source and assumption version in saved plan results so an update cannot silently rewrite an earlier illustration. Do not guess future increases or scrape live rates during a client calculation.

The scenario must say **"Assumes the standard personal rate of Illness Benefit"**. It represents a full year at that rate, not an exact first claim year or a promise of permanent payment. Illness Benefit is taxable, with no USC or PRSI, and new claims are time-limited under the [operational guidelines](https://www.gov.ie/en/department-of-social-protection/publications/operational-guidelines-illness-benefit/). The B2 brief must define the duration and savings-runway treatment; it cannot extrapolate the payment indefinitely.

Implementation needs the protection adapter, shared tax engine **and a scenario-specific income contract in the gap engine**. The current engine retains the other person's base `takeHome`; an adapter cannot fix that by changing only `statePayment`. Each case must accept the recalculated take-home amounts for its people and the State-payment component separately, with their calculation year, tax-rule/assumption versions and stated/estimated basis. Keep the gross benefit source and its estimated tax traceable; never bury a change in the working partner's tax inside the State-payment segment. All displayed components must reconcile to the shared tax engine's household net income. The existing Stage 1 manual contract remains in force until this is built and tested. A stated amount, including an explicit zero after #77, remains distinct from a central assumption.

**Each scenario starts from the same household and opening tax history.** Build its income items afresh, remove the stopped salary, add Illness Benefit under its own income type and run `computeTaxYear` for the whole household. The existing function defaults to a fresh state and copies an explicitly supplied opening state. Never pass one alternative's returned `nextState` into another alternative; carry it only from one year to the next within the same route. Tests must prove that A–B–A and B–A–B give identical results for the same case and leave their inputs and common opening history unchanged.

**Illness Benefit is the recipient's taxable income.** It is not added to the other person's salary. [Revenue's Illness Benefit guidance](https://www.revenue.ie/en/jobs-and-pensions/taxation-of-social-welfare-payments/illness-occupational-injury-partial-capacity-benefits.aspx) makes it liable to Income Tax, but not USC or PRSI. Include the appropriate personal Employee Tax Credit, which Revenue permits for taxable [DSP income](https://www.revenue.ie/en/personal-tax-credits-reliefs-and-exemptions/income-and-employment/employee-tax-credit/index.aspx). Do not encode the benefit as employment or as a retirement State Pension merely to get similar tax arithmetic.

Under [joint assessment](https://www.revenue.ie/en/life-events-and-personal-circumstances/marital-status/marriage-and-civil-partnerships/joint-assessment.aspx), taxable benefit can count as the lower-income spouse's income for the extra standard-rate band. The 2026 [Revenue rates table](https://www.revenue.ie/en/personal-tax-credits-reliefs-and-exemptions/tax-relief-charts/index.aspx) gives €53,000 plus the lower of €35,000 and the lower person's taxable income. With a €75,000 salary and €13,208 taxable personal Illness Benefit, the combined 20% band is €66,208. The €13,208 increase belongs to the benefit recipient: it does not give the working spouse €66,208 of salary at 20%. The increase and Employee Tax Credit are non-transferable. Per-person estimates must respect those restrictions and state their credit-allocation basis; they must not be presented as an exact payroll notification. The selected year's rules supply all figures; do not hard-code these examples into the engine.

**Explanation on the client screen:** place this under the protection picture with its other assumptions when scenario tax calculations are implemented: "Tax is recalculated for each case. If one of you stops working, the other person's take-home may change." Explain beside the payment that it is shown after estimated tax. Use a single-person variant without the partner sentence. Until that implementation lands, retain the current warning that the other person's tax can change and the shown take-home may differ; do not claim that the current manual screen already recalculates it.

The B2 change updates the module's provenance, footnote, assumptions table and prompt-pack wording together, removing the requirement to confirm every hypothetical payment as a client fact. Required regression cases include a jointly assessed couple with either person sick, a single person, zero payment, the benefit below and above the Employee Tax Credit threshold, non-transferable bands/credits, unchanged USC/PRSI on the benefit and deterministic reruns in different orders.

Verification on 17 October: the existing tax engine passed all 64 tax tests. An additional frozen-input audit repeated A–B–A and other call orders, confirmed equal outputs and unchanged inputs, and confirmed independent copies of shared opening pension-tax history. It also confirmed that `illnessBenefit` is currently refused as an unrecognised income type. That is a required extension, not an implemented protection scenario.

Expense-label phrasing belongs to the final AI authoring stage, with no deterministic rewriting of natural language. The [expense-label decision note](backlog/ai-authored-expense-labels.md) records Gerry's instruction, the deferred implementation and the historical #71 phone-layout finding and its merged positioning fix.

## 7. The order of work

Two tracks run side by side. Track A builds the module screens, one Claude Code chat per module as now. Track B builds the plan layer in one new chat. Design tasks sit between them.

| Step | What | Waits for | Who |
|---|---|---|---|
| D1 | Red "short" state merged in #71 and #76 | Complete | Module work |
| A1 | Future cost fund screen and wiring complete on `main`; its updated wiring list remains the pattern | Complete | Future cost fund module |
| A2 | Cash flow, short state and today's pension contributions merged (#71/#82/#83) | Complete | Cash flow module |
| A3 | Protection gap and confirmed zero-payment extension merged (#77) | Complete | Protection module |
| A4 | Goals engine, timeline fields, app wiring and relief footnotes merged (#75/#76) | Complete | Goals module |
| A5 | Care costs: a new adviser-only module for long-term care, including the Fair Deal scheme. Brief first, in its own session | Gerry's review of its brief | Care costs module |
| P | Existing module prompt contracts merged, including cash flow and home trade down (#83) | Complete for current modules | Claude |
| B0 | Plan pack v1: format, validator, compiler and `check:plan-pack`; implementation in #80 | Merged in #80; supported/deferred builders in the v1 contract | Plan chat |
| B1 | The resource ledger: resources available and required, goal states in the method's order, the balance test, route order and what each route changes | Merged in #85. Cash flow owns left over; a separate stated amount is allowed only without that chapter. | Plan chat |
| B1.1 | Freed cash in every route: a loan's repayment comes back after its native schedule ends. Each person's share of the yearly surplus stops funding goals from their own retirement year | B1; in #87 | Plan chat |
| B1.5 | The storyteller: story facts, the inefficiency issue list, the nine story sections with the five education-only parts, route recipes, risks from stress runs, and golden plans for B4 ([brief](plan-pack-b15-story-brief.md)) | B1.1, and Gerry's review of the brief | Plan chat |
| B1.6 | Stories after the goals: growth inside then outside the pension to retirement and life expectancy, gifts to children within the small gift exemption, spending more in retirement, and a spouse's income after a death. Adds gift tax rules to the tax engine and the post-retirement growth, life expectancy and DB assumptions (brief section 5) | B1.5, and Gerry's decisions 5 to 7 | Plan chat |
| B2 | Adapters from the household profile for cash flow, protection gap, future cost fund and goals, with the profile fields from section 6; central Illness Benefit assumption, shared-engine tax treatment and duration contract | Each module's engine; versioned assumptions and tax support for illness scenarios | Plan chat |
| D2 | The plan view: the current position and the routes side by side, laid out around the B1.5 story sections | B1.5's story sections and B1's output shape | Claude Design |
| B3 | The plan view built, route-to-case selection, the "not following the route" note, presenter beats | D2, B1, B2 | Plan chat |
| B4 | The plan playbook (how an author writes a plan pack) and the golden plan packs: Niamh and Dara in public, and the five CFP case studies kept out of the public repository | B1.5 and the case notes | Gerry and Claude |
| Later | Property chapters as routes, where a sale's proceeds become money now. The consumer questions from section 6. The website version through the API. | B3 | |

B0 merged in #80 and B1 in #85: allocation, the protected reserve, ordinary-CGT sale proceeds and the balance test. B1.1 credits freed cash and stops each person's surplus at retirement. B1.5 tells each route's story in the method's order, and the plan view (D2) is designed around its sections. B1.6 adds the growth, gift and later-life stories; the care costs module joins them once it is built. B2 completes the missing screen/profile adapters and illness-tax contracts.

The module screens stay adviser-only (`consumer: false`) as their briefs say. The plan view starts the same way.

## 8. The prompt pack

Every new module needs its place in `docs/prompt-pack/`, so an author can write its payload from a call: a playbook, its spoken names in `01_playbook_aliases.md`, its row in `02_schema_capability_matrix.md`, the assembled `MASTER_PROJECT_PROMPT.md`, and examples in `90_` and `91_`. The plan adds one more playbook, for writing a plan pack; that is B4.

- **When:** after each module's code is merged, never before, so the playbook describes what the code does. Each brief ends with a "contract summary for the prompt pack" for exactly this.
- **Who:** Claude, one pull request per module. No app code changes.
- **The module chats do not touch `docs/prompt-pack/`.** Their briefs already say so.
- **Consumer routing stays off.** Playbooks carry a `planeir-planning-module` marker that feeds `js/planning/playbook_manifest.generated.js`. A new module's playbook leaves that marker out until the module has a registry entry and an adapter (B2), so the consumer pipeline never routes to a module it cannot run.

The module prompt contracts above are merged, including cash flow and home trade down in #83 and the protection zero-payment contract. B4 adds the plan-pack authoring playbook. Keep prompt-pack updates separate from module-code changes.

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

1. Review and merge B1.1 (#87).
2. Review the [B1.5 storyteller brief](plan-pack-b15-story-brief.md) and its decisions, then build B1.5 and B1.6. Review the care costs module brief in its own pull request.
3. Build B2: complete exact goals/future-cost screen adapters, automatic profile facts and the approved illness payment, tax and duration contracts. Add the optional investment-sale intake facts and the fund/ETF sale adapter where needed.
4. Design/build the linked plan view (D2/B3) around the B1.5 story sections, then write B4’s AI authoring playbook against the golden plans. Consumer activation remains off until its adapters and questions are complete.
