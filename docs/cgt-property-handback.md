# Capital gains tax on property: handback

Built on 11 October 2026 on branch `cgt-property-disposal`. This adds the first Part B head from `docs/irish-tax-app-change.md`: capital gains tax on selling property. Shares, funds, dividends, DIRT and CAT are still refused. `docs/prompt-pack/` is untouched; section 3 is what the playbooks and `MASTER_PROJECT_PROMPT.md` need when a module starts sending sales.

## 1. What changed, by file

- `js/planning/tax/heads/capital_gains.js` (new): the head. Indexation, principal private residence, the 2011 to 2014 relief, losses (this year, a jointly assessed spouse's, then carried forward), the annual exemption and the rate on the date of sale.
- `js/planning/tax/rules_ie.js`: the 2026 block gains `capitalGainsTax` (the €1,270 exemption); `IE_LEGISLATED_SCHEDULES.capitalGainsTaxRate` holds 33% and the 31% announced in Budget 2027; new `IE_CGT_FIXED_RULES` holds the s.556 multiplier table and the s.604A dates. Nine new sources. `IE_TAX_RULES_VERSION` is now `ie-tax-2026.2`. No existing value changed.
- `js/planning/tax/resolve.js`: resolved rules carry `capitalGainsTax`, with the rate schedule checked.
- `js/planning/tax/engine.js`: `propertyDisposal` is now an event type, validated field by field. Results gain `capitalGains` (each sale and each person) and `totals.capitalGainsTax`, which is in `totalTax` but not in `netIncome`. `marginalTax` reports it.
- `js/planning/tax/disclosures.js`: 16 new disclosure codes, all `applied`. The "not included" item on investments now excludes property.
- `js/tests_ie_tax.js` and `scripts/run-pension-math-tests.mjs`: 11 golden cases (C1 to C10), 6 new checks and 13 new invalid inputs. The CLI parity check now compares `capitalGains` too.

## 2. Results

- Tax tests 56 of 56 (was 39), pension tests 58 of 58 unchanged, CLI parity on 28 golden cases (was 17).
- `npm run check:consumer`, `npm run check:no-stale-exports` and `npm run build` pass.
- C1 to C3 are Revenue's own worked examples (Tax and Duty Manual Part 19-02-13, Examples 1, 4 and 5). The s.604A check reproduces Part 19-07-03A, Examples 1 to 3.

## 3. The input, for the playbooks and MASTER

One event per sale, in the tax year of the sale:

```json
{
  "type": "propertyDisposal",
  "personId": "a",
  "disposalDate": "2027-03-01",
  "proceeds": 320000,
  "sellingCosts": 6000,
  "acquisitionDate": "2013-06-15",
  "acquisitionCost": 250000,
  "acquiredBy": "purchase",
  "homeUse": "unknown"
}
```

- `personId`: a person, or `"joint"` to split the sale equally between two people. Each owner gets their own exemption.
- `acquisitionDate`: the date of the unconditional contract. Before 6 April 1974 is refused.
- `acquisitionCost`: the price paid, or the market value when inherited or gifted.
- `sellingCosts`: optional, default 0.
- `acquiredBy`: `purchase` or `gift_or_inheritance`. Required, because only a purchase qualifies for the 2011 to 2014 relief.
- `homeUse`: `never`, `part`, `throughout` or `unknown` (default). `throughout` asserts full principal private residence relief. `part` and `unknown` tax the whole gain and show a note that the tax could be lower.
- Buying costs and improvement spending are not inputs. A note says they would lower the tax.

## 4. Verify before release (Gerry)

1. **Part years under s.604A.** Revenue's examples only use whole years, each selling a day after the anniversary. The engine counts part years exactly, so Revenue's Example 2 gives €209,942 of relief rather than €210,000. That errs slightly against the client; rounding down to whole years would match Revenue's examples exactly. Confirm which you want.
2. **Losses on an s.604A property** are allowed only in the share a gain would have been chargeable (s.546(3)). Revenue's manual does not show an example.
3. **Order of losses.** This year's own losses, then a jointly assessed spouse's unused loss, then losses carried forward, then the exemption, each taken against the highest-rate gain first. The election to keep a loss from a spouse is not modelled.
4. **The 31% rate** is marked `announced`. Switch it to `enacted` when Finance Act 2026 passes.

## 5. Things noticed

- The brief's Part B table still says 33%. Revenue's page now gives 31% for sales from 7 October 2026. The brief is unchanged; the catalogue follows Revenue.
- Revenue's history table prints the start of the 33% period as 6 December 2021. The row before ends on 5 December 2012, so 2012 is meant. Recorded as 2012; only sales from 2026 are calculated, so nothing turns on it.
- Section 14 of the brief asks for a 2027 block on Budget day. That has not been added here, so 2027 onward still use the 2026 bands, credits and USC. Only the CGT rate change from Budget 2027 is included.
- Development land, connected-person sales and foreign tax credits are not modelled; a standing note says so.
