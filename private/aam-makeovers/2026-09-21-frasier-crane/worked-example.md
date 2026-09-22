# Worked example: Frasier Crane

Gold standard built by Gerry, 21 Sept 2026. Source thread in `thread.md`; the five module payloads in `case-pack.json` (proposed case-pack format), cleaned of runtime-owned fields and checked against the app's own normalisers and validators on 21 Sept 2026. One deliberate change from Gerry's original build: the Clear Mortgage case is timed for the end of the fixed rate (rule 15). `bridge_model.py` rebuilds the model behind the fifth module and reproduces every figure in it.

This file does two jobs: it shows the call plan this build implies, in the format the makeover workflow will use at plan review, and it records the judgement rules the build teaches.

---

## 1. The call plan this build implies

### Fact sheet

| Area | Fact | Source |
|---|---|---|
| Household | Frasier 54, spouse 60, daughter 26 (working, at home, disciplined saver, about €50k saved) | #1, #9, #10 |
| Income | Frasier €200k gross (€130k base plus RSUs); spouse €50k; €5k a month net after pension, AVCs and ESPP | #1 |
| Spending | About €3,500 a month excluding mortgage (€42,000 a year, holidays of about €12k assumed inside it); mortgage €946 a month (€11,352 a year); total outgoings €53,352 | #1 |
| Cash | Frasier €50k, spouse €100k | #1 |
| Investments | Employer shares $250k, about €220k (poster's conversion) | #1 |
| Property | Home €800k; Spanish holiday home about €200k, no mortgage, no rent, about €3k a year to run; leaning towards selling | #1, #8 |
| DC pensions | €143k Irish Life, €124k New Ireland; spouse DC small, value unknown | #1 |
| Income pensions | UK DB £24k a year at 65, index-linked; foreign annuity product about €12k a year at retirement age, not index-linked, lump-sum option | #1, #8, #14 |
| State Pensions | UK full for both; Irish 12 years (Frasier), about 10 years (spouse) | #1 |
| Mortgage | €90k, 2.35% fixed to 30/09/2027, 109 months left, €946 a month | #1 |
| Protection | Mortgage protection; health insurance and death in service through work | #1 |
| Near-term spending, no amounts | Car replacement, possible home improvements | #1 |

**Poster's questions:** early retirement or part-time within 2 to 3 years (primary); spouse stepping back too; possible move to Spain; sell the shares and diversify (where?); clear the mortgage?; move the UK DB pension?; DC default strategies and consolidation; is projected pension income about €60k to €70k?; help the daughter buy.

**Thread additions:** clear the mortgage (ClubMan, patfert1); wait until the fixed rate ends in Sept 2027 (givecredit); max the spouse's pension contributions and leave default strategies (givecredit); help the daughter with a parental mortgage rather than a gift (Brendan Burgess); about €72k of pension income from 66 and about €837k of bridge assets (Sarenco), which the poster asked him to expand on (#14).

### Module running order

1. **Personal Balance Sheet** with three alternatives: Diversify Company Shares, Sell Foreign Property, Retirement-Ready Portfolio.
2. **Liquidity Plan** on retired thresholds.
3. **Mortgage: Continue or Clear.** Clear case timed for when the fixed rate ends (rule 15).
4. **Report: Later-Life Retirement Income.** Answers "about €60k to €70k?" and tests Sarenco's €72k with a line-by-line build.
5. **Report: Retirement Bridge, could you retire at 57?** Answers the primary question on a year-by-year model, and gives the poster the expansion of Sarenco's bridge point he asked for.

### Left out, and where it went instead

- Spain and tax residence: caveats and a checklist item in both Reports.
- UK DB transfer, DC default strategy and consolidation: not modelled; product decisions where no figure on screen changes.
- Daughter (gift versus parental mortgage), spouse pension top-up, wills, life cover: not modelled.
- Where to invest: only as "Diversified investments" rows; no product detail.

---

## 2. Rules this build teaches

### Balance sheet

1. One household balance sheet. Label rows by owner when ownership is split ("Frasier cash", "Spouse cash").
2. Income-only pensions and unvalued pots appear as €0 rows labelled "future income" or "value not provided", so they are visible without distorting net worth.
3. Classify by use, not asset type: a personal-use holiday home is Lifestyle; concentrated employer shares are Legacy.
4. Foreign currency uses the poster's own conversion where given, otherwise an explicit rate stated in the assumptions table.
5. Include an assumptions table (Assumption, Value) covering classification calls, €0 rows and how annual expenditure is built. The PBS playbook omits it by default; makeovers include it.
6. `pbsInputs.annualExpenditure` is total current outgoings including mortgage repayments.
7. When the main goal is retiring within a few years, use `retirementStatus: "retired"` so the reserve is judged on the 12 and 24 month retired buffer, and say so in the summary.
8. Alternatives are the asset decisions the poster raised or leaned towards, one decision per case, then a combined end-state case last. Single-decision cases carry movements; the combined case can omit them.
9. The combined case keeps exactly the retired target reserve (two years of outgoings) in cash and puts everything else available into "Diversified investments" under Longevity.
10. No tax haircuts on balance sheet cases, so net worth stays level across them. Tax belongs in the Report model.

### Liquidity

11. Same expenditure and retirement status as the balance sheet.
12. Near-term purchases with no stated amount are not ringfenced. They become a next step asking the client to check the surplus against them. A purchase with a stated amount is ringfenced: its own row under Liquidity on the balance sheet, excluded from the Liquidity module.
13. Headline states whether the target is covered and the surplus. Three next steps: keep the reserve, allow for planned spending, review the rest alongside the mortgage and investment options.

### Mortgage

14. "Should I clear the mortgage?" becomes two cases: Current Position and Clear Mortgage (lump sum equals the balance). The actual repayment goes in `fixedPaymentAmount`; remaining months divided by 12 is the term.
15. When a fixed rate ends soon, the Clear case's lump sum lands when the fix ends: `oneOffOverpaymentMonth` is the months from the start date to the end of the fixed period (12 for Frasier). The module still offers paying today alongside it. The breakage-fee caveat goes in the notes for Gerry, since the module can't carry our copy (rule 16). Decided 21 Sept 2026; Gerry's original build cleared immediately, and `case-pack.json` now carries the timed version.
16. The app replaces the mortgage summary with the engine's own text on apply, and Gerry keeps it that way, so the payload carries no summary.

### Retirement

17. Use a Report built on a year-by-year model whenever savings or investments must fund a gap before pensions start, or income comes from DB, foreign or partial State Pensions. Use the Retirement module for straightforward DC accumulation. Decided 21 Sept 2026.
18. Bridge model settings are chosen per case and listed at plan review. Frasier's settings are an example, not defaults.

### Reports

19. Sequence Reports as a story: first answer the question the poster asked, then pivot to the question that actually decides things. The first Report's last callout sets up the second.
20. Every figure comes from a model, and the Report says so in its source list.
21. Build income from first principles and state each conversion: FX rate (£1 = €1.16), the actual full UK new State Pension rather than the poster's rounded figure, Irish State Pension pro rata to contribution years out of 40, all labelled illustrative.
22. Compare like with like or flag it: gross income against current spending carries a "different bases" annotation.
23. Use mortgage-free spending for later-life comparisons when the mortgage ends first; use total outgoings for the reserve.
24. Take test parameters from the poster's own words: "maybe in another 2-3 years" becomes retirement at 57.
25. Stress assumptions are deliberately harsh and disclosed in an accordion titled along the lines of "Why this is deliberately a difficult test".
26. The hero row answers the question in one line ("Unfunded shortfall: None").
27. Each Report ends with a verification checklist and a closing callout on the bigger picture or the next question.

### Scope

28. Five modules for a rich case. Qualitative or product questions become checklist items or caveats rather than modules.

---

## 3. The bridge model

`bridge_model.py` rebuilds the model behind the fifth module. It reproduces all eleven years of both charts and every KPI (checked 21 Sept 2026). It is becoming the standard script behind bridge Reports, with every setting chosen per case (rule 18). The settings used for Frasier:

- **DC pot to retirement:** €267,000 growing 5% a year; contributions added at year end: personal at the age-related limit (30% at 54, 35% at 55 and 56) of the €115,000 earnings cap, plus €7,800 employer (6% of the €130k base). Result: €454,224 at 57.
- **At retirement:** 25% tax-free lump sum (€113,556), held at 0% and spent first; the rest (€340,668) to an ARF growing 5%.
- **ARF:** 4% distribution from age 61 on the post-growth value, taxed at 30%.
- **Accessible portfolio:** share proceeds after a stress CGT charge (33% on the whole value less the €1,270 exemption, €147,819) plus cash above the two-year reserve (€43,296), grown at 5% to retirement (€221,240). Afterwards it grows 5% and funds any shortfall at year end.
- **Protected reserve:** two years of current outgoings (€106,704), at 0%, never touched.
- **Spending:** €42,000 inflating 2% a year from today, plus mortgage repayments to 62 and a final €946 at 63.
- **State Pensions:** inflate 2% a year from today. Irish pro rata to contribution years out of 40, with years added while working (both stop when Frasier retires): 15/40 for Frasier from 66, 13/40 for the spouse from her 66. UK full rate at 67 for each (spouse at her 67).
- **Other pensions:** UK DB from 65, indexed 2% from today; foreign product €12,000 flat from 65.
- **Tax:** 30% effective on all pension income and ARF distributions.
- **Spouse:** stops working when Frasier retires.
