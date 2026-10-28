# Dated costs: the B1.5 part 1a contract

Implemented on `b15/dated-cost-contract`. This is section 6a's shared funding path for college and the future cost fund. The care producer, retirement-years run, what-if catalogue and screens are separate work. The future-cost-fund payload is unchanged, including its start range of 1 to 40 years.

## Funding core

`computeDatedCostFunding` in `js/future_cost_fund_math.js` is an internal API. It takes a `costKind`, `startsInYears`, and either a nominal `costYears: [{yearIndex, cost}]` schedule or `annualCostToday` and `durationYears`. A nominal schedule is not inflated again. Its options require an explicit `calculationYear`; plan callers derive it from the pack's `calculationDate`, never the system date.

`cashToday` is cash already set aside, growing at the central instant-access rate after DIRT. It reduces both the remaining lump-sum requirement and the recalculated yearly money. Overfunding is refused. All flows fall at the start of the year.

| `funding` | What it does |
|---|---|
| `save_then_pay` | Solve a level annual saving from `savingStartsInYears` (default 0) until the cost starts. A cost starting now cannot use this mode. |
| `each_year` | Pay each bill when it falls due. Without opening cash there is no fund. With opening cash, draw that cash and its net interest first, then pay the remainder from the household's money. |
| `lump_sum_now` | Work out the cash required today to pay the complete schedule. |

Internal callers may use a start of 0. Internal schedules also cover up to 70 consecutive years for a cost's lead time and duration, including the saving years transferred to retirement; the public payload's duration remains 1 to 30. No internal option is read from a module payload.

## Producer result

`createDatedCost` in `js/planning/dated_costs/contract.js` checks the shared contract. The two producers are `produceCollegeCost` and `produceFutureCostFundCost` in that directory. `plan_producers.js` binds plan facts to them; the ledger has one dated-cost pricing path.

| Field | Meaning |
|---|---|
| `contractVersion` | `dated-cost-1.0.0` |
| `costId`, `goalId`, `title` | The cost, its goal and its display name |
| `producer` | `{module, version}`, naming the producer |
| `payerIds` | The people paying it |
| `costByYear[]` | Nominal bills and tax relief, keyed by calendar `year` |
| `moneyNow` | The additional lump sum needed today, after `cashToday` |
| `moneyEachYear[]` | `{year, amount}` for the yearly funding alternative, recalculated for the same `cashToday` |
| `retirementSplit` | `year`, `before[]`, `after[]`, and `capitalNeededAtRetirement` |
| `assumptions` | Central cash rate before/after DIRT, tax rule and assumptions versions, calculation year and timing |
| `provenance` | Calculation date, input, opening cash, funding mode, payer boundaries, original present value and module-specific cost source |

The three amounts in each `costByYear[]` row are **`amountBeforeRelief`**, **`reliefAmount`** and **`amountAfterRelief`**. Each row also carries `reliefClaims: [{claimantId, amount, rulesVersion}]`. Claims name a payer and the tax rules version, sum to `reliefAmount`, and satisfy:

```text
amountBeforeRelief - reliefAmount = amountAfterRelief
```

The producer obtains relief from the tax engine; the contract does not calculate a percentage or apply relief again. College and future-cost-fund rows currently have zero relief and empty claims. The care brief can align its row names to these fields without changing this funding core.

College's bills come directly from its native nominal year rows, including any one-off support. The future-cost producer uses the existing engine's inflation and cost schedule. Both hand the same after-relief bills to the same funding calculation. Funding a nominal schedule carries no unused inflation default; each producer records the growth assumption that actually built its bills.

## The ledger and retirement

`moneyNow` and `moneyEachYear` are alternative ways of meeting the same remaining cost; they are never added. Assigned cash and route `useCash` are passed to the producer once. `whole` supplies the remaining `moneyNow`; part cash reduces the yearly amounts through a fresh quote. Only the route's actual cash allocation consumes spare cash.

Plan funding facts optionally name `payerIds` and `funding` (`save_then_pay` or `each_year`). Without explicit payers, the cost uses the household's positive income shares, recorded as that policy in provenance. A lump sum is a `useCash` route change, not another payload amount. Every ledger year reads the producer's own yearly figure.

Payer boundaries reuse B1.1's working-share calculation. Split when the last payer's working share stops, including a working payer retiring this year. An already-retired payer has a continuing share and does not acquire a second retirement boundary. `before` and `after` partition `moneyEachYear`; the later amounts' present value at the split, using the same central net cash rate, is `capitalNeededAtRetirement`.

The later money is removed from the dated-cost yearly requirements and appears under retirement with the cost's name followed by **“after retirement”**, for example **“School fees after retirement”**. The ledger funds that cash capital before the boundary through the same funding core. It counts those transfers in cash flow as goal funding, without pension relief. An existing retirement goal owns the requirement; otherwise the ledger shows a separate retirement-capital row, without inventing a household pension-income target. The CLI prints each capital requirement beneath retirement. No retirement-years projection is introduced.

The unchanged future-cost screen can now compile a named future dated cost with `save_then_pay`, including a route's part or whole cash. Both producer and module-check passes receive the explicit plan year. The screen shows the funding requirement, distinct from today's actual saving. Immediate costs, direct yearly payment and accelerated retirement-split funding are priced by the contract but still require their own screen adapter; they are not relabelled as a supported case.

## Checks and figure changes

`npm run check:dated-cost-contract` runs in CI. Its separate reference imports nothing from the engine or contract; it simulates nominal flows and solves funding by bisection. It covers the four seams, the nominal/real-rate equivalence, relief reconciliation, payer boundaries, module equivalence after part cash, ledger allocation and explicit-date chapter compilation. Missing dates, unknown payers and non-finite or overfunded schedules fail.

The unchanged `check:future-cost-fund` and `check:college-funding-audit` continue to pass. A made-up fixture captured from main pins the native bills and funding cases to the cent. A comparison of 4,573 comparable figures in the existing B1 plan fixture found no movement of a cent or more.

| Existing sample figure | Before and after |
|---|---|
| Future cost fund, full cash today | €86,066.18 |
| Future cost fund, save each year | €10,808.76 |
| Future cost fund, half cash and yearly saving | €43,033.09 and €5,404.38 |
| Future cost fund, delayed saving | €17,328.84 a year |
| College, at home: today's total / nominal bills | €20,000.00 / €29,057.90 |
| College, away: today's total / nominal bills | €60,000.00 / €87,173.69 |

New behavior is confined to newly supported funding shapes: a varying schedule uses its actual yearly bills; part cash reprices them; needs after all payers stop working become retirement capital funded beforehand. These replace the former repeated annual amount or unfunded later years. The compiler version becomes `plan-pack-1.2.0`, so compiled identifiers and provenance change even when the financial figures do not. The old future-cost-chapter refusal becomes compilation for supported dated inputs; unnamed costs still fail, and unsupported screen shapes remain explicit.

No course material is used in these checks. `docs/prompt-pack/`, care code and all screens are unchanged.
