# The plan and its routes: implementation plan

Written 13 October 2026, with the four decisions in section 4 settled that evening. Status and order refreshed 27 October 2026, covering work through #95 and distinguishing merged work from open PRs. The central illness-scenario assumption was approved on 17 October. This sets the order for the module screens and the plan layer; each step gets its own brief before it is built. B0, B1 and B1.1 are merged (#80, #85 and #87), against the [v1 contract](plan-pack-v1.md) and [B1 brief](plan-pack-b1-brief.md). The [B1.5 brief](plan-pack-b15-story-brief.md) records Gerry's five settled decisions, the confirmed-form journey and the shared tool interface. #88 remains open for his review; this PR changes documentation and the private-case ignore rule only.

## 1. Where things stand

| Piece | Where | State |
|---|---|---|
| Future cost fund | `main` (#55 and #57) | Engine, screen, wiring, central cash rate and DIRT built and tested. Prompt-pack entry merged. |
| Household cash flow | `main` (#71, #82, #83) | Bounded short-state charts and phone layout merged. Today's contributions and their app/prompt contracts are merged; stated take-home is bank pay after the personal pension deduction. |
| Goals and resources | `main` (#58, #67, #70, #75, #76) | Engine, calendar-year wording, Proposal A screen, app wiring and conditional relief footnotes merged. |
| Protection gap | `main` (#61, #65, #77) | Engine, screen, wiring and prompt-pack entry built. Confirmed €0 State payments and sourced Irish payment references merged. The approved central assumption for hypothetical illness scenarios is specified below; its adapter and tax support remain to be built. |
| Property decisions | Rental on `main` (#64, #66); home trade down on `main` (#72) | Both modules built and wired. Shared phone grids also include #73. Property chapters remain outside the first version of the plan. |
| Plan pack and ledger | `main` (#80, #85, #87) | B0's format, compiler and checker, B1's allocation, protected reserve, sale proceeds and balance test, and B1.1's freed cash and each person's retirement boundary are merged. |
| Story screen | `plan-pack-story-view` | Local screen work exists; tidy and push it together first. Reading any compiled plan and then opening checked story links remain separate steps in section 7. |
| B1.5 brief | #88, `plan-pack-b15-brief` | Open for Gerry's review. The five decisions are settled below and in the brief. Build in two parts, followed by the tool interface and matching links; no analyst or generation job is built by this PR. |
| Care brief and calculations | Brief #89 open; central figures and nursing-home tax relief on `main` (#91) | Finish the care brief. #91 builds rows 1 and 2 only: central prices and care assumptions, plus income-tax relief through the shared tax engine. Fair Deal rules, care calculations, funding and the screen remain to build; the complete care engine is not yet available. |
| Figures register | `main` (#90) | One generated register of law, market figures and central assumptions, with sources, dates and versions. `getFigures` and `{figure.<id>}` narration are built; B1.5 adds `read_figures` to the shared tool interface (section 11). The 2027 announced tax and welfare records are included. |
| Market refresh job | `main` (#92) | Quote-reading script, dry-run/apply/PR modes and checks are merged. Unread pages remain unchanged and reviewed values need a person. Scheduling the weekly run is still a separate action. |
| State Pension by plan year | `main` (#93) | The retained worker code reads the rate for the plan's year and uses shared wording, source and status; typed copies are removed. This does not reconnect the retired conversation UI. |
| Form-to-analysis journey | `main` (#94, merged 27 October) | Conversation intake, adviser test launchers and call navigation are retired. The form schema is `js/case_application/schema.js`; `worker/src/demo/` saves revisions and confirmation on the private page. Generation is not connected. The first analyses run in Claude Code, checked and reviewed by Gerry before release. |
| Walkthrough check | `main` (#86) | The booking check's time-of-day failure is fixed. It adds no analysis-generation path. |
| Mortgage illustration and assumption approvals | #95 open, `figures/mortgage-illustration-rate` | Proposes 4.00% from the 27 October quotes, the reviewed-date rule, two-decimal chart labels and the recorded approval of the 4% after-tax growth and enacted-or-announced tax wording. These changes are not on `main` yet; do not describe them as merged or copy their values into narration. |
| On `main` | | Mortgage, loan, pension, net retirement, college cost, cash reserve and balance sheet engines. The Irish tax engine, now with CGT on property. Household profile v1 with its adapters, module registry and orchestrator. Case packs and the presenter. |

Module briefs accompany the code. #83 includes the final cash-flow and home-trade-down prompt contracts. The remaining plan work is the form-to-profile conversion and adapters (B2), B1.5's shared pieces and story checks, care, the compiled-plan screen and links, then B4's analyst. Website generation comes last as a tracked job with Gerry's release step. Section 7 sets that order; no live intake is restored.

## 2. What the first version does, end to end

1. **Start from a confirmed form.** A person gives their details in the application form, saved by `worker/src/demo/`, confirms the saved revision and chooses **Generate my analysis**. B2 converts that confirmed version to the household profile and then the plan's household. The generation action is not connected yet.
2. **First, the analyst runs in Claude Code.** It reads that confirmed household, decides which routes and what-ifs matter, sets them from the facts, and runs the engines through the same tools the later website analyst will use; it never does maths. The pack holds the household's facts once, how far each goal could move, and up to three routes beside the current position. Rates, bands, limits and payments come from `read_figures`, with `{figure.<id>}` in narration.
3. **A missing fact stops the first run for one follow-up form.** `missing_facts` returns either an existing application-schema path or a new question with its proposed path, label and type, and the affected result. The person gets a short follow-up form on their private page and confirms a new revision; the analysis starts afresh from that version. Only one round is allowed per analysis request. After that, it runs on what it has and says what it could not show. A run never guesses a missing fact, treats an unanswered fact as zero or asks it in live chat.
4. **The same plan-pack check compiles and prices it.** `npm run check:plan-pack -- <pack.json> --ledger` builds chapter payloads from household facts and route changes, runs the engines and prices the ledger in the method's order. It refuses unbalanced routes, changes outside stated flexibility and typed figures. B1.5 adds story completeness and wording checks and requires every linked figure to equal what the linked module shows in the compiled route case, using the compiled plan rather than samples.
5. **Gerry reviews each checked analysis before release.** The app loads the released compiled plan like a case pack. The story screen shows the current position and routes, their money-now and money-each-year pictures and goals. Picking a route selects the matching chapter cases; a story figure opens its source module and focus target. Choosing another chapter case shows that the screen no longer follows the route.
6. **Later, Generate my analysis starts a tracked website job.** It is pinned to the confirmed revision, uses the same tools, one-follow-up rule and plan-pack check, and waits for Gerry to release the result. A passing check is not publication. The format, tools and check stay the same for Claude Code and website runs.

## 3. Rules the code carries

- **One household, one set of facts.** A chapter never states a figure the household already holds, so two chapters cannot disagree.
- **Every euro is counted once.** Money a route puts toward one goal is no longer available to another goal or to any other chapter. This is the resource ledger's "do not double count" rule.
- **Goals are taken in the planning method's order** (section 4, decision 4), never in an order the payload states.
- **Pension money is gross for growth and after relief for cash flow** (section 4, decision 1).
- **A route states what changes, never the result.** The engines solve the amounts.
- **The current position comes first, and it is "nothing changes".** Every other route must balance: cash used is no more than the spare cash, and what the goals need each year is no more than what is left over. A route that does not balance fails the check and is never drawn.
- **Routes are never ranked.** They are ordered by how much they change from the current position and named neutrally. Each says what it changes, above all a goal that moves.
- **Money now and money each year are never drawn on one scale or added together.** As in the method's ledger, alternatives are never totalled: a route picks one way of funding each goal and only that is added up.
- **Narration types no figures.** Every amount in it is a placeholder the ledger fills, and every rate, band, limit or weekly payment is a `{figure.<id>}` placeholder the figures register fills (section 11).
- **Every linked story figure matches its module.** The checker reads the compiled route's `chapterCases`, compiled chapter input and result, and `nativeCaseId`; the value, unit and displayed rounding must equal what the linked module shows for that case and focus target. The evidence comes from the compiled plan, never module samples. Wrong cases, missing targets and unequal figures are refused, including a wrong case with a coincidentally equal value ([B1.5 brief](plan-pack-b15-story-brief.md), section 1).
- **Confirmed facts only, with one follow-up round.** A missing fact becomes a form question, the analysis stops and runs afresh after confirmation. Remaining gaps are explicit limitations, never invented values; a modelling default is labelled as an assumption and never substitutes for a household fact.
- **Checked and reviewed before release.** Claude Code and the later website job use one tool interface and the same plan-pack check. Gerry reviews each analysis before it is released.
- **Every dated cost reaches the ledger in one shape.** College, the future cost fund and care all produce the same dated-cost contract: money each year, money now, the split before and after the payers' retirement, and any tax relief with who claims it. The ledger has one path for dated costs, never a branch per module ([B1.5 brief](plan-pack-b15-story-brief.md), section 6a).
- **There is one retirement-years run.** One projection to age 100, drawing pension, ARF and savings, serves every later-life story. A later-life what-if is a change to that run (an extra outgoing, an income change or a return change), never a model of its own, so two answers cannot disagree (section 6b).
- **Every what-if is a tool, not a fixed scenario.** Each has a typed parameter schema generated from its engine's normaliser, bounds and central defaults, and returns code facts. Every parameter is a household fact, a central default or a bounded value with a reason that cites a fact; anything else is refused (sections 6c and 6d).
- **Every engine built from now on is exposed as a tool in the catalogue.**
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
2. **Wealth preservation.** The emergency reserve is set aside from cash before anything else. Protection comes next: the income gap and how long savings last, counting stated existing cover. A payout is money received and a protected mortgage is cleared; the screen never shows a cover amount needed, a gap against cover, a premium, a product or a provider. No purchase of cover takes money in the ledger.
3. **Removing inefficiencies.** List all loans and cards other than the mortgage, dearest first, with rate, balance and yearly cost under `debts_other_than_mortgage`, without a rate threshold. Where a route clears one from spare cash, that comes before the goals. `idle_cash_vs_debt` already shows where cash earns less than a loan costs; no arrears, penalties or promotional-rate facts are added.
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

**The form and the household profile are different contracts.** The current form is defined in `js/case_application/schema.js`, saved and confirmed by `worker/src/demo/`; it already collects many ages, incomes, pensions, debts, assets and goals. Its `profilePath` hints are not a converter. B2 step 1 converts a confirmed form revision into a household profile, step 2 makes that profile the plan's household and connects cash flow and goals, and step 3 completes protection and college adapters and the illness scenario. Reuse existing form paths before proposing new questions.

Missing, and needed before a plan can run from the profile alone:

| Gap | Why it matters | Where it goes |
|---|---|---|
| Total spending, not only essentials | The app asks essential spending excluding housing debt, which is right for the cash reserve. Left over each year needs everything spent, or it is overstated. | A question, `expenses.annualTotal` already exists in the profile |
| Married or civil partners, or not | Decides joint assessment. The form already collects `household.married`; the profile binding is still needed. | Carry the confirmed existing answer into a profile field; do not ask a duplicate question |
| When the mortgage should be cleared | The mortgage goal needs an age. | A goal target date, which the profile already holds; nothing asks for it yet |
| How far each goal could move | Routes may only move a goal within what the client said is possible (a later retirement, a lower target, a longer mortgage). | A question per goal, kept in the plan pack |
| Other dated costs | Care for a parent or school fees need a start, a number of years and a yearly cost. | Goal target date and amount exist; the number of years does not |
| State payment in a hypothetical illness scenario | Standard personal Illness Benefit rate for an employed person assumed to qualify. | A central, sourced, dated planning assumption; never a question asking the client to predict an entitlement. See the contract below. |
| Survivor's payment after a death | A separate scenario with different eligibility and tax treatment. | Keep the existing stated-input contract until its own assumption is designed; the illness default does not select a survivor's payment. |
| Whether the mortgage would be cleared on a death | The protection chapter's need after a death depends on it. | A question |
| Existing cover and sick pay | The form has broad `cover.life` and `cover.incomeProtection` answers; the what-ifs also need stated amounts, terms, whose life, mortgage bindings, death-in-service, benefit/waiting period and sick pay. Personal cover and employer death-in-service stay separate; an unstated fact is never zero. | Extend the form with optional detail questions, initially or in the one private-page follow-up ([B1.5 brief](plan-pack-b15-story-brief.md), sections 7 and 8) |
| Investment preference | Growth stories run only in investment mixes at or below the mix the client says they are comfortable with; without an answer they stay at the base case. | One optional question, recorded as stated, never as a suitability assessment ([B1.5 brief](plan-pack-b15-story-brief.md), section 5) |
| Property (later) | Rent, running costs, purchase date and price, how it was acquired, whether it was ever a home. | Questions, when property joins the plan |

B0, B1 and B1.1 already support authored packs. For the first real analyses in Claude Code, the form's newly confirmed revision supplies the facts through B2; missing facts follow the one-round form contract in the B1.5 brief. After that round the run states what it could not show and carries those limitations in `check_next`, including any required what-if it could not calculate. The question/schema additions come in section 7's third group, before website generation is connected. Approved central what-if defaults and bounds are in the B1.5 brief's section 6c, dated and versioned; the home's share of net worth uses its value less its mortgage over net worth.

### Approved illness-scenario assumption

The form collects current household facts. It must not ask what disability payment someone would receive in a hypothetical future illness. For the standard scenario, assume an employed person becomes unable to work, their employer sick pay has ended, and they qualify for the standard personal rate of **Illness Benefit**. This is an illustrative assumption, not an award or a finding of eligibility. Use one personal rate, without dependent increases. The employee assumption must not silently be applied to self-employment or retirement; use the employment facts already collected to identify its scope, without building a benefits questionnaire.

Keep the rate in the central planning assumptions, with the scheme, weekly amount, source, checked date, effective dates, approval status and version. The record now exists in the figures register (section 11) as `ie.social_welfare.illness_benefit.personal_highest`, a weekly personal rate by effective date with its Department of Social Protection source and the day it was read. The [Department's scheme page](https://www.gov.ie/en/service/ddf6e3-illness-benefit/) gives a 2026 maximum personal rate of €254 weekly, or €13,208 for a 52-week illustration. [Budget 2027](https://prelive.oireachtas.ie/en/debates/debate/dail/2026-10-06/3/) announces a €10 weekly increase: €264, or €13,728 over 52 weeks, is the derived future reference. Keep it separate from the rate currently payable; verify the scheme's commencement before activation. Do not add the separate cost-of-disability lump sum to recurring illness income.

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

The order below is settled by Gerry on 27 October. Work in each group can proceed together; move to the next group when the contracts it needs are ready. Section 1 holds the completed work, including B0, B1 and B1.1, so none of those is a new gate here.

| Order | Work, in order within the group | What this establishes |
|---|---|---|
| First, together | Tidy and push the story screen; this B1.5 brief; finish the care brief (#89); form to household profile (**B2 step 1**). | The screen and both briefs are reviewable, and a confirmed form revision can become a household profile without invented facts. |
| Then | **B1.5 build part 1:** shared pieces and what-if tools; **B2 step 2:** cash-flow and goals adapters, with the plan's household from the profile; Fair Deal rules and care calculations; the story screen showing any compiled plan. | The dated-cost contract, parameter checks and what-if catalogue have the shared shape in brief section 6. The screen reads compiled plans rather than a fixed sample. #91's central care figures and nursing-home tax relief are reused; it did not build the complete care calculation. |
| Then | New form questions; **B1.5 build part 2:** story facts, issue list, link sources and checker; **B2 step 3:** protection-gap and college-fund adapters, the Illness Benefit default, and the protection playbook stops stating rates; care funding and screen. | Required facts have schema paths or validated proposed questions. The checker specifies the matching rule for linked figures. Protection uses the income/tax/duration contract in section 6, reads figures from the register and counts stated existing cover without showing a cover need. |
| Then | The tool interface; story links from compiled plans with the matching check. | One schema and executor per tool serve Claude Code and the later website job, including `read_figures` and `missing_facts`. Every story link opens the compiled route's module case and target, and its figure equals what that module shows. |
| Then | **The analyst (B4)**, run from Claude Code, with golden plans from the course cases kept only in `private/cfp-cases/` on Gerry's Mac. | Build the prompt and loop over the tools; test locally against the private goldens and publicly against made-up examples. Gerry reviews each checked analysis before release. |
| Last | Connect **Generate my analysis** to a tracked job that Gerry releases; then a whole-journey test with made-up households. | The job uses a confirmed revision, the same tools and plan-pack check, and at most one follow-up form. A checked result waits for Gerry's release. The journey test covers confirmation, follow-up and fresh rerun, remaining limitations, review, release, route selection and matching story links. |

B1.5's overall scope remains story facts, the what-if catalogue, the tool interface and the checker; the rows split that build without changing its contract. D2/B3 is now staged as the tidy story screen, then any compiled plan, then checked module links, rather than waiting for every plan feature before showing anything.

**Extensions kept on the plan.** B1.6 remains the later-life run to age 100 and the growth, gift and later-life stories in brief sections 5 and 6b, with the four investment mixes, preference ceiling and disclosure, gift-tax rules and DB assumptions. Entries waiting for those engines stay unavailable. It is not an extra gate inserted into the first-release order above. Property chapters as routes and the fund/ETF sale adapter remain later work; the ordinary-CGT sale path is already in B1.

The module screens stay adviser-only (`consumer: false`) as their briefs say. The plan view starts the same way. The retired conversation intake is not part of this order. Prompt-pack changes named above get their own later change; this PR leaves `docs/prompt-pack/` untouched.

## 8. The prompt pack

Every new module needs its place in `docs/prompt-pack/`, so an author can write its payload from confirmed facts: a playbook, its spoken names in `01_playbook_aliases.md`, its row in `02_schema_capability_matrix.md`, the assembled `MASTER_PROJECT_PROMPT.md`, and examples in `90_` and `91_`. B4 adds the analyst's plan-pack authoring prompt; the first runs are in Claude Code.

- **When:** after each module's code is merged, never before, so the playbook describes what the code does. Each brief ends with a "contract summary for the prompt pack" for exactly this.
- **Who:** Claude, one pull request per module. No app code changes.
- **The module chats do not touch `docs/prompt-pack/`.** Their briefs already say so.
- **Consumer routing stays off.** Playbooks carry a `planeir-planning-module` marker that feeds `js/planning/playbook_manifest.generated.js`. A new module's playbook leaves that marker out until the module has a registry entry and an adapter (B2), so the consumer pipeline never routes to a module it cannot run.

The module prompt contracts above are merged, including cash flow and home trade down in #83 and the protection zero-payment contract. In section 7's B2 step 3, a separate change makes the protection playbook stop stating rates itself and read them through the figures register. Keep prompt-pack updates separate from module-code changes. This PR does not edit `docs/prompt-pack/`.

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

Start section 7's first group together: tidy and push the story screen, review this B1.5 brief, finish the care brief and convert the confirmed form to a household profile (B2 step 1). B1.1 (#87) is already merged. The five decisions in the B1.5 brief are settled; #88 remains open for Gerry to review the updated brief and this plan.

Follow section 7 for the build order rather than starting website generation early. The first analyst is B4 in Claude Code, with local CFP golden plans only in ignored `private/cfp-cases/` and made-up public examples. `.gitignore` does not untrack an earlier commit: `git ls-files -- private/cfp-cases/` must return nothing before a commit or push. Website generation remains unconnected until the final tracked-job step, and every result waits for Gerry's release.

## 11. The figures register, and the analyst loop

Every figure that can change sits in one register: law, market prices and Planeir's own assumptions, each with its value, its source and when it was checked. It is generated from the catalogues the engines already import (`npm run build:figures`) into `js/planning/figures/figures_index.generated.js` and the readable `docs/figures-register.md`, and `npm run check:figures` holds it to its rules (a source and a check date for every figure, no quantity defined twice, a market figure past its review interval flagged, a Budget recorded without a block for its year refused). A weekly job collects market quotes and opens a pull request when one moves (`docs/figures-market-refresh.md`); code does the arithmetic.

- **Narration.** The plan pack resolves `{figure.<id>}` from the register the same way it resolves engine figures, showing the value as the register shows it (20%, €44,000, age 65). A figure typed into narration is still refused, and so is an id the register does not hold. A compiled plan records the register's version with its other versions.
- **Reading.** `getFigures({ ids, kinds, module, onDate })` in `js/planning/figures/get_figures.js` is read-only. It refuses an unknown id rather than leaving a figure out, returns the value in force on `onDate` when asked, and carries no bank or lender name: a market figure's quotes are internal provenance.
- **The analyst loop.** The B1.5 brief (PR [#88](https://github.com/geraldboylan01/Call-Template/pull/88), section 7) includes `read_figures`, backed by `getFigures`, next to `read_position`, `price_route` and the others. Its parameters are the same four. The first analyst runs in Claude Code; the later tracked website job calls the same interface and uses the same plan-pack check before Gerry's review and release. The analyst states a rate, band, limit or weekly payment only by reading it there, retains its `source`, `checkedOn` and version, and uses `{figure.<id>}` in narration. A quantity absent from the register is reported for source review, never estimated or turned into a household question. Missing household facts instead use `missing_facts` and the one private-page follow-up form; the analysis then starts afresh from the newly confirmed revision. After that round, still-missing facts produce explicit limitations.
- **What it does not do.** The register holds no client's data and the repository is public, so nothing about a client goes in it.
