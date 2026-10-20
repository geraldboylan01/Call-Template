# B1: resources and route balance

Prepared 19 October 2026; implementation and checks updated 20 October after #80 merged at `6f16b08852c0c73365dda82cc5e2e0af0f274dae`. B1 builds the resource ledger over the B0 compiler. The plan screen, automatic consumer routing, illness tax and final AI wording remain later stages.

## Contract

Keep B0 compilation available. `check:plan-pack -- <pack> --ledger` requires B1 pricing and balance checks; the compiler receives the equivalent explicit option. A B0-only result cannot be mistaken for a checked resource plan. B3 must require the B1 option before displaying a linked plan.

Use household facts once. Additional funding facts may identify assets already assigned to a goal, a child's education goal, current saving towards a dated cost (including confirmed zero), its duration and the spending basis. Amounts and dates already on a goal are referenced there. No author-supplied rates, prices, goal states, priority order or balance conclusions.

The current route remains "nothing changes": current repayments, pension deductions, earmarked assets and stated saving. Its unmet goals and any deficit are shown. Alternative routes must protect the reserve and meet their required funding in every model year; otherwise the checker fails and exports no successful case pack.

## Resource order

1. Show the existing cash-flow deficit first. Negative left over cannot become an available resource.
2. Protect the opening reserve using the existing liquidity adapter and central target policy. Cash already earmarked for a goal is unavailable for a second purpose. The opening reserve is not released merely because a proposed route reduces its regular spending.
3. Apply explicit loan/outgoing clearances, before allocating further resources.
4. Price dated costs in start-date order, then the mortgage, then retirement. Preserve a stable order for equal dates; never rank goals using their supplied priority.

Money now and money each year remain separate. Existing pension pots are restricted to retirement; a second retirement goal cannot spend them again. Unsupported goals or unknown resource ownership/tax treatment require facts or a later adapter rather than a zero requirement.

Each route starts from the same frozen facts and opening tax history. Tests repeat routes in A–B–A and B–A–B order and check unchanged inputs. Retain the assumptions/tax versions, native inputs and result provenance.

## Goal pricing

Reuse the existing calculators and contribution search. Mortgage targets use the native amortisation schedule, dated costs use the future-cost fund, and pension growth and relief use the pension/shared-tax engines. Share the existing pension search with the goals module rather than copying it. Preserve individual retirement ages and per-person contributions.

`whole` resolves the amount required to fund that goal now; `remaining` uses unallocated resources up to the goal's supported limit. Resolve explicit instructions and funding order deterministically, without changing authored labels. Never use the same cash, investment proceeds, annual exemption or pension pot twice.

For each year, record available money, each goal's requirement, allocation, shortfall and money remaining. Pension growth uses gross contributions; resource requirements use their incremental cost after relief. Current personal deductions already included in bank pay are not deducted twice. Report relief-limited unmet targets separately from whether their funding fits.

Add the resource and goal placeholders to the existing own-route registry. Do not rewrite narration or expense labels. Order routes neutrally by the resources/goals they change, with current first; never by an outcome score.

The native goals screen derives its own four cases. B1 must match a route exactly or retain an explicit later-adapter diagnostic. It must not relabel its "cash stays" funding case as the current position. A priced ledger does not imply every requested screen adapter exists.

## Investment sales — Gerry's decision, 19 October

An unallocated investment's market value is not spendable cash. Show the holding separately and price its net proceeds through the shared tax engine. A route must explicitly identify a sale before its proceeds become cash. Extend the route contract with `sellAsset` identifying the whole asset; partial-lot sales are outside this contract.

For a known ordinary CGT investment, use its stated tax base cost. If it is missing, assume a €0 base cost and prominently state: "Base cost not supplied. This illustration assumes a €0 base cost, so the full sale value is treated as a gain before applicable costs and allowances." Preserve a supplied zero as stated, distinct from the fallback. Missing market value remains missing information.

Before B1 the CGT engine priced property sales only. B1 adds a generic investment disposal to that engine and reuses its rate-by-date, annual exemption and loss settlement. Do not route shares through property reliefs or create a second CGT formula in the ledger. Settle all sales in one route together so the annual exemption is applied once per person. Retain the existing statement about other gains/losses not included in the illustration.

Keep known CGT investments distinct from funds/ETFs and unknown tax treatment. The existing investment-fund code provides disclosures, not an exit-tax sale calculation. Do not price either as CGT to obtain an answer.

The asset/profile contract should retain optional base cost and sale interest. The intake should ask for base cost when someone wants to explore a sale and explain that it improves the estimate; it must not make that field compulsory for every asset. The current client planning intake is conversational; adding a full asset form or automatic consumer sale routing belongs with the intake/profile work. Record the conditional question and expose the optional fact without activating a sale flow.

## Verification and delivery

- Reserve protection, current deficits, explicit loan clearances and one-use resource accounting.
- `whole`/`remaining`, funding order, partial funding, out-of-bounds changes and same-goal moves.
- Native-engine comparisons for debt, dated funding and pension cost after relief, including unequal salaries and retirement ages.
- No double subtraction of existing saving/pension deductions; no double use of an investment or allowance.
- Stated and missing base cost, loss-making sales, multiple assets/owners, date-selected rates, unsupported fund treatment and A–B–A sale tax independence.
- Current remains a valid diagnostic picture when short; an unbalanced alternative is refused, with its ledger retained for diagnosis.
- Existing module contracts, B0/case-pack checks, no new stale exports and build.

Deliver a B1 implementation PR with the exact authoring contract, examples and diagnostics. The user has authorized merging #80; a B1 merge is a separate step.

The native protection illustration takes whole euros. Round calculated route inputs only at that boundary and record the assumption; the ledger retains full precision. Require the cash-flow chapter when a changed pension deduction feeds protection so per-person bank pay cannot remain stale.

B1 refuses the B0 college and net-retirement screen adapters until B2 can bind the exact child/date and unassigned after-tax capital/bank pay. Their native engines still price the ledger where appropriate; successful B0 illustrations remain available in B0 mode.
