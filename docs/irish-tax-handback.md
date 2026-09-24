# Irish tax engine: handback

Handback for `docs/irish-tax-app-change.md` (brief version 4), built on 23 September 2026 on branch `retirement-cases`. Part A is built. Nothing from Part B is built. `docs/prompt-pack/` is untouched; section 2 below is what the retirement playbook and `MASTER_PROJECT_PROMPT.md` need.

## 1. What changed, by file

New:

- `js/planning/tax/rules_ie.js`: the dated catalogue. The 2026 block (bands, credits, age exemption, USC, PRSI liability, lump sums, CET) and the legislated schedules (PRSI by date, SFT fixed amounts). Also `IE_TAX_SOURCES`, with every source from 4.10. The one value not in section 4 is `lumpSum.maxShareOfFund: 0.25`, which the brief's 7.1 "max" option needs.
- `js/planning/tax/resolve.js`: `resolveTaxRules(year)` applies the section 5 policy. Also `resolveSft`, and `recordPublishedSft`, which refuses a figure below the previous year's.
- `js/planning/tax/engine.js`: `computeTaxYear`, `marginalTax`, `solveForNet` and `createTaxState`. Input validation names the failing field, and Part B types are refused.
- `js/planning/tax/heads/`: `lump_sum.js`, `sft.js` (exports `crystallise`), `arf_imputed.js`, `income_tax.js`, `usc.js` and `prsi.js`. Each exports `{ id, phase, compute(context) }`.
- `js/planning/tax/disclosures.js`: code to text, with every figure filled from the catalogue. Also the "not included" list and its compact line.
- `scripts/ie-tax.mjs` and `npm run tax:estimate`: the commands `year`, `marginal`, `solve` and `rules <year>`.
- `js/tests_ie_tax.js`: the golden cases, rule resolution, SFT, ARF, immutability, Part B refusal, field-named errors, disclosure wording and a timing check.

Changed:

- `js/planning/ireland_rules.js`: the ARF imputed distribution correction (4.9), plus `irishArfFirstAttainedAge`.
- `js/planning/planeir_assumptions.js`: the `taxProjection` assumption, `assumptionRecord('taxProjection')`, a label, and version `planeir-assumptions-1.2.0`.
- `js/pension_math.js`:
  - `computeSft` is now a thin wrapper over the catalogue.
  - The post-2029 wording in `buildSftSummarySentence` is rewritten to match `SFT_HELD`.
  - The new inputs, crystallisation at retirement, tax in every projected year, net mode and per-member SFT testing.
  - The new rows, disclosures, chart series and `debug.tax`.
- `js/charts.js`:
  - A net income line, and income tax, USC and PRSI lines that start hidden.
  - A "Net income and tax" legend group whose tax chips start muted.
  - The "Required net income" label.
  - The income panel is still recognised as a pension chart in net mode. Without this it rendered as plain stacked bars; the browser check caught it.
- `js/render.js`: the table formatter read "€2.8 million" as "€2.8m" plus "illion". It now leaves an amount alone when a word like "million" follows it.
- `js/state.js`: the session importer now keeps the new tax keys. It whitelists keys, so it would otherwise have dropped them.
- `js/app.js`: Dev Panel hook `window.__runIeTaxTests`.
- `scripts/run-pension-math-tests.mjs` (`npm run test:pension`): runs both suites, checks CLI parity on every golden case, reports timings and fails if the 60-year solve exceeds 300 ms.
- `js/tests_pension_math.js`: two tests updated (section 3) and 12 added, including a case fixture proving that the tax keys pass through cases.
- `scripts/check-pension-projection-audit.mjs`: the ARF block (section 3).
- `scripts/fixtures/module-catalogue-authoring-identity.json`: the assumptions version string, which follows the bump.
- `docs/irish-tax-app-change.md`: the brief itself, at the suggested path.

## 2. New `pensionInputs` keys, for the retirement playbook and MASTER

| Key | Level | Values | Default |
|---|---|---|---|
| `householdTaxStatus` | `pensionInputs` | `single`, `married_or_civil_partners`, `widowed_or_surviving_civil_partner` (one pension only) | Not given: each member is assessed as single. Couples see `STATUS_DEFAULT_SINGLE`, one person sees `STATUS_SINGLE` |
| `targetIncomeBasis` | `pensionInputs` | `gross`, `net` | `gross` |
| `rentalIncomeOwnerId` | `pensionInputs` | a pension id, or `joint` (two pensions only) | the only member, or `joint` for two |
| `lumpSum` | each `pensions[]` member, or top level in the single-person shape | `{ "mode": "none" }`, `{ "mode": "max" }` (25% of the fund), `{ "mode": "amount", "amount": 500000 }` | `none` |
| `priorLumpSumsSince2005` | member, or top level | euro, 0 or more | 0 |
| `sftAlreadyUsed` | member, or top level | euro, 0 or more | 0 |
| `unrelievedLumpSumTax` | member, or top level | euro, 0 or more | 0 |
| `taxTreatment` | each `otherIncomeSources[]` item | `occupational_pension`, `rental`, `employment`, `social_welfare`, `non_taxable` | `db` and `annuity` become `occupational_pension`; `rental` becomes `rental`; anything else becomes `occupational_pension`, with `OTHER_INCOME_AS_PENSION` disclosed |

Behaviour to describe:

- **Cases.** The new keys are not case overrides. Every case inherits them, and each case still equals its standalone payload (the new fixture "Married couple with an after-tax target and a lump sum").
- **Crystallisation.** Each member crystallises once on the current and max paths, in the first year their pension is drawn (their retirement year, or the income start year if that is later). The lump sum leaves as cash. The drawdown fund is the fund less the lump sum and the net CET.
- **Pot comparisons.** Required and projected pots are compared as drawdown funds. The required-pot search never crystallises. When a lump sum or CET changes a fund, the pot rows add ", after lump sum and tax at retirement" to their labels.
- **Net mode.** Each year's elected withdrawal is solved so that income after income tax, USC and PRSI meets the target, split pro rata as before. A shortfall is the net gap at maximum withdrawal. The rows read "Target net income", the chart line reads "Required net income", and affordable mode reports "Affordable net income".
- **Gross mode.** Tax is shown for information only. No gross figure changes.

Validation messages, exact (`<member>` is `pensions[i]`, or `legacy` in the single-person shape; inside a case the existing case prefix applies and `legacy.` is dropped):

- `generated.pensionInputs.householdTaxStatus must be one of: single, married_or_civil_partners, widowed_or_surviving_civil_partner.`
- `generated.pensionInputs.householdTaxStatus widowed_or_surviving_civil_partner describes one person, but the payload has 2 pensions.`
- `generated.pensionInputs.targetIncomeBasis must be "gross" or "net".`
- `generated.pensionInputs.targetIncomeBasis "net" needs currentYear 2026 or later, because tax is only estimated from 2026.`
- `generated.pensionInputs.rentalIncomeOwnerId "joint" splits rent between two people, but the payload has one pension.`
- `generated.pensionInputs.rentalIncomeOwnerId must match a pension id, or be "joint".`
- `generated.pensionInputs.<member>.lumpSum must be an object such as { "mode": "max" }.`
- `generated.pensionInputs.<member>.lumpSum.mode must be "none", "max" or "amount".`
- `generated.pensionInputs.<member>.lumpSum.amount must be a finite number.` (or `must be greater than or equal to 0.`)
- `generated.pensionInputs.<member>.sftAlreadyUsed must be greater than or equal to 0.` (same for `priorLumpSumsSince2005` and `unrelievedLumpSumTax`)
- `generated.pensionInputs.otherIncomeSources[0].taxTreatment must be one of: occupational_pension, rental, employment, social_welfare, non_taxable.`
- `generated.pensionInputs: the lump sum of €5,000,000 for Pension is more than the projected fund of €1,336,648 at retirement.`

New output rows. All rows that existed before are kept.

- `Estimated income tax, first year of income (2051)`, plus the same for USC and PRSI; net income nominal and in today's money; and the effective tax rate.
- `Estimated net income once the State Pension is fully in payment (2051), nominal` and `, today's money`.
- Per member with a lump sum: `retirement lump sum (gross)`, `estimated tax on the retirement lump sum` and `retirement lump sum after tax`.
- Per member at retirement: `fund at retirement (year)` and `Standard Fund Threshold at retirement`, which reads `€2,800,000 (2031, held at the last known figure)` for a held year. Where there is a chargeable excess, also: chargeable excess, CET before and after credit, credit applied and credit carried forward. A carried credit with no excess gets a row of its own, as does a drawdown fund that differs from the fund.
- Per earner: `net cost of current personal contribution` and `net cost of maximum personal contribution`, for example `€4,080 a year (€340 a month)`.
- A household prefixes each per-member row with the member's title, as the existing rows do.

New assumption rows:

- `Target income basis`, `Household tax status`, any lump sum and prior-limit inputs, and `Rental income for tax` for a couple with rent.
- The `taxProjection` assumption.
- One row per disclosure: the standing codes always, the applied codes when triggered.
- `Not included in tax estimates`, a compact line. The full list is in `debug.tax.notIncluded` and in the CLI output.
- The existing `ARF minimum withdrawals` row now reads "None until the year you turn 61; then 4% a year, 5% from the year you turn 71, and 6% while an individual fund exceeds €2m; valued at the start of each year".

New chart series in the income panel:

- `Net income (current)` is visible, and `Net income (max)` follows the max toggle.
- `Income tax`, `USC` and `PRSI` (current and max) start hidden.
- All of them are in the CSV. The per-year series use tax on recurring income: tax caused by the Schedule E part of a lump sum is charged to the lump sum.

## 3. Pinned tests whose expected values changed

| Test | Before | After | Reason (7.8) |
|---|---|---|---|
| `tests_pension_math`: "ARF minimum withdrawals apply at 4, 5 and 6 percent" (now "...follow the whole-year age test...") | €100,000 at attained age 60: €4,000. At 70: €5,000. €2.1m at 60: €126,000 | €500,000 at 60: €0. At 61: €20,000. At 70: €20,000. At 71: €25,000. €2.1m at 61: €126,000. At 58: €0 | 2 |
| `tests_pension_math`: "Mandatory withdrawal surplus is calculated and exported without charting" | Age 60, €2.5m fund: first-year minimum €150,000, surplus €140,000 | At 60 there is no minimum, so the test moved to age 61. CET of €120,000 first, then a minimum of €142,800 and a surplus of €132,800 | 2, then 1 |
| `check-pension-projection-audit`: ARF rule block | `higherRateFromAge: 70`; `irishArfMinimumRate(70, 500000) = 0.05`; pinned staggered pot €240,545.38 | `minimumWholeYearAge: 60`, `higherRateWholeYearAge: 70`; rate at 70 is 0.04, at 60 is 0, at 71 is 0.05. Pinned pot €255,256.31 (neither member is 61 before 2031, so both pots grow untouched: 2 × €100,000 × 1.05⁵) | 2 |
| `module-catalogue-authoring-identity.json` fixture | `(planeir-assumptions-1.1.0)` | `(planeir-assumptions-1.2.0)` | Not a 7.8 reason: it follows the version bump the brief asks for |

Replay evidence: every payload the pension suite and audit pass to the engine was recorded, along with the JSON fixtures and the Dev Panel examples (104 distinct payloads without the new keys). Each was replayed through the committed code and the new code.

- Against the committed code, 102 differ. Every one differs in the ARF row text, and most also in withdrawals or balances, because of reason 2.
- Against the committed code with only the ARF correction applied, 99 are identical. The five that differ are explained:
  - Two funds above the SFT now pay CET (reason 1). One is the moved surplus test; the other is a new test.
  - The new per-member SFT test (reasons 1 and 3).
  - The audit's two staggered couples. Their `SFT threshold used` row changes from `€2.8m (held beyond 2029)` to `Pension €2.6m (2028); Partner €2.8m (2031, held)`, with no change to the breach flags (reason 3).

Other existing tests still pass while their underlying figures moved with the ARF correction, because they assert relationships rather than pinned values. Examples: the couple's required pot went from €1,454,615 to €1,452,276. A client retiring at 60 went from a first-year minimum of €21,387 to €0, and from €36,048 elected to €57,434.

## 4. The SFT from 2030

`resolveSft` and `resolveTaxRules` give €2,800,000 with `sftBasis` `held` for every year from 2030 to 2100. The test checks each year, and also that the threshold never falls.

A recorded published figure (tested with a hypothetical €3,000,000 for 2030) is `fixed` for 2030 and `held` after it. A figure below the previous year's is refused.

Nothing projects the threshold, and there is no earnings assumption.

## 5. Timings

Median in Node 25 on this Mac, as printed by `npm run test:pension`:

| What | Time |
|---|---|
| 60-year household projection, `solveForNet` every year (the 3.4 requirement) | 2.2 ms |
| Retirement module, couple, gross target, taxes reported | 5.7 ms |
| Retirement module, couple, net target (solver every year, inside the required-pot search) | 76 ms |
| Retirement module, couple, net affordable income | 119 ms |

## 6. Where the brief disagreed with the code or the sources

Built as written and flagged, because 11 says to report rather than silently fix:

1. **The chargeable excess formula double counts once the threshold is already exceeded.** max(0, used + fund - SFT) charges the earlier excess again when `sftAlreadyUsed` is above the SFT. Example: €3m already used against €2.8m, then a €100,000 crystallisation, gives €300,000 of excess instead of €100,000. It errs against the client. Chapter 25 measures the excess against the threshold still available, which suggests max(0, fund - max(0, SFT - used)). This only matters when `sftAlreadyUsed` is above the threshold.
2. **Default `taxTreatment`.** "Anything else to `occupational_pension`" also catches:
   - type `employment`, which the retirement-cases fixtures use for part-time work;
   - `rental_or_lease_income`, used for land lease income;
   - the adapter's DB income, which is `type: 'pension'`, not `db` (this one is harmless).

   Part-time earnings and lease income are therefore taxed with no PRSI and, for lease income, with the employee credit. That understates tax, against decision 9. Suggested fix: map `employment` to `employment` and `rental_or_lease_income` to `rental`, or have the playbook always state `taxTreatment`.
3. **The retirement adapter sends net income as if it were gross.** `buildPensionProjectionInput` uses `netAnnual ?? grossAnnual` for other income. With tax now estimated, a net figure is taxed a second time. Not changed; it is outside this brief.
4. **The adapter never sends `lumpSum`.** The manifest lists `pension_retirement_lump_sum` as a required fact, but the consumer path always gets `none`.

Decisions where the brief was silent:

5. **Crystallisation year.** It is the first year the pension is drawn: the retirement year, or `incomeStartYear` if later. An example is the "Stop at 58, draw from 62" case.
6. **Status line for one person.** Without a status, one person gets `STATUS_SINGLE`, because the `STATUS_DEFAULT_SINGLE` text says "each of you".
7. **Other income with no owner, or an unknown owner.** In a couple it is split equally, like household income.
8. **Employee credit and the band increase** use employment income after pension contributions (taxable pay). This matters only below about €10,000.
9. **Net income** is income less income tax, USC and PRSI. Bridge-year pension contributions are not deducted, which matches the gross model counting the full salary.
10. **Per-member rows.** Fund and threshold are always shown. The CET rows appear only when there is an excess, so a household is not shown eight rows of zeros per member.
11. **"Receiving the State Pension (Contributory)"** for the 66 to 69 PRSI test means the State Pension is included and has started.
12. **Projections starting before 2026** (old sessions) show one "no tax figures" assumption row instead of failing. A net target there is refused.
13. **Engine age limit.** It accepts ages up to 150. A couple's horizon runs to the younger partner's 100th birthday, so an older partner can pass 120.
14. **Lump sum close to the whole fund.** If the net CET is more than the fund left after the lump sum, the rest comes out of the lump sum.
15. **CLI `solve`.** `adjustable` is declarative (`{ "split": [{ personId, type, share }] }`), because a function cannot travel as JSON.
16. **`bridge_model.py`** is not in this repository. The CLI is ready for it.

Verify before release (12) is unchanged. In addition:

- `check:consumer-planning` fails at the committed code on `js/planning/playbook_manifest.generated.js`; the new tax files pass that rule.
- `check:no-stale-exports` fails only on the untracked presenter files (`presenter.js`, `presenter_catalogue.js`, `presenter_package.js`).
