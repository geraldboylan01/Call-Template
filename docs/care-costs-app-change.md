# Care costs: build status and how the engine differs from the brief

The brief is `docs/care-costs-module-brief.md` (PR #89). This file follows "Wiring a new engine module" in `docs/future-cost-fund-app-change.md`, row by row, and says what is built, what is not, and where the engine made a choice the brief left open.

## Build status

| Row | What | State |
|---|---|---|
| 1 | Central care figures in `planeir_assumptions.js` | Built (PR #91). The HSE price list was re-derived from list 231 here. |
| 1b | Fair Deal rules catalogue `js/planning/care/fair_deal_rules_ie.js`, the State Pension (Non-Contributory) series in `social_welfare_ie.js`, the register collector | Built |
| 2 | Nursing home relief in the tax engine (`nursingHomeExpenses`) | Built (PR #91) |
| 3 | `scripts/fixtures/module-catalogue-authoring-identity.json` | Version strings follow the assumptions version by search and replace. The check itself fails on a migration filename on main. |
| 4 | `js/care_costs_math.js`, with the assessment in `js/planning/care/fair_deal.js` | Built as far as the family's yearly amounts before and after relief |
| 5 | `js/tests_care_costs_math.js`, `scripts/check-care-costs.mjs`, `npm run check:care-costs` | Built, with the independent reference calculator |
| 6 to 19 | View, module, CSS, preview, state, pipeline, app, render, presenter, video, wiring suite | Not built |
| 20 | `check:care-costs` in `.github/workflows/consumer-regression.yml` and `deploy-worker.yml` | Done |
| 21 | This file | |

Not built, and listed in `debug.notYetBuilt`:

- `lumpSumNow`, `yearlyFromHousehold` and `retirementCapitalNeeded`, which need the funding core's extensions in `js/future_cost_fund_math.js` (start 0, a schedule of costs, paying each year, cash already put towards the cost). The plan chat is building them.
- `summary`, the dated-cost contract of the plan pack (B1.5 section 6a). The care producer follows once the plan chat's contract lands.
- `charts` (one chart for the video summary).
- The `care` what-if of the retirement-years run (B1.5 6b and 6c).

## Choices the engine made where the brief was silent

- **Years, not weeks.** Schedule 1 is worked in weeks and multiplied by 52. Every step is a share or a subtraction, so working in years gives the same figures; the reference calculator in `scripts/check-care-costs.mjs` works in weeks from the Act's own wording and agrees to the cent.
- **Money rises with prices.** The person's incomes, rent, other deductions and the payer's incomes rise with general prices (the central 2%); tax bands are not indexed, as the tax engine holds them. The home and other property are valued once, when care starts, grown with prices to that day; their borrowings stay as entered.
- **The partner of a person in care is taken to be the same age.** The brief's `couple` holds only `partnerIncomes`. The age only matters for the over-65 rules, and the person in care is the one who sets them.
- **The family meets extras last.** Extras do not qualify for relief, so the relief is on the family's share above the extras (`nursingHomePart`). That never overstates the relief.
- **One claimant.** The relief is the fall in the payer household's tax from deducting the nursing home part. Two people assessed jointly pool the expense; the first person is named as the claimant (`claimantId`).
- **Rows.** Beside the brief's row fields each row carries `contribution` (what the person pays towards the fee: the assessment in a Fair Deal year, the fee in a private year), `nursingHomePart`, `claimantId`, `calendarYear`, `fairDealWouldNotLowerTheCost` and the figures that set the income part (`netIncome`, `eligibleRent`, `retainedIncomeThreshold`, `safeguardBinds`). The parts of the assessment (`incomePart`, `savingsPart`, `otherPropertyPart`, `homePart`) are what was assessed, also in a private year, so a private year shows what Fair Deal would have asked.
- **Totals.** `fairDealYears` lists care-year numbers (counted from entering care). `homePartTotal` is the home part in the years Fair Deal applies; `homePartAssessedTotal` is the assessed total over every year, which the 22.5% cap is checked against. `savingsLastYears` is the number of whole years the savings met what they were asked for, and `savingsRunOutYear` the care year they ran short.
- **The State Pension rate** is the one in force on the day care starts (the calculation date for care already under way), kept for every year of that care.
- **Injection.** `options` takes the calculation date, the central assumptions, a tax catalogue, a Fair Deal catalogue, `flatReliefRate` and `privateAllowance: 'none'`. A payload cannot reach any of them; a payload that carries a rate, a share, a cap or a disregard is refused.

## The private course cases

`private/cfp-cases/` is in `.gitignore` and holds nothing from this change. `npm run check:care-costs` runs any `care-costs-<name>.json` it finds there (inputs, options and the figures to compare, documented in `scripts/check-care-costs.mjs`) and reports "not present" when the folder is missing. The runner is proved here on a made-up case in a temporary folder. The course's lump sums wait for the funding core.
