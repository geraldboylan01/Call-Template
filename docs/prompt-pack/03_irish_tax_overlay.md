# Irish Tax Overlay

This is a cross-playbook overlay, not a standalone output playbook.

Use it whenever Gerry's scenario materially involves Irish tax logic, relief testing, or workbook-style tax calculations.

## Primary Reference File
If the uploaded file `irish_tax_ai_cheat_sheet_v1.1.md` is available, use it as the primary logic source for:
- CGT
- CAT
- Corporation Tax
- Income Tax relief logic covered by the sheet
- Stamp Duty logic covered by the sheet
- mixed-head scenarios such as gifts, business transfers, or succession where more than one tax head may apply

## Trigger Cues
Apply this overlay whenever Gerry mentions or implies:
- gift, inheritance, estate, succession, transfer to child, favourite niece or nephew
- disposal of shares or business assets
- retirement relief, entrepreneur relief, incorporation relief
- business sale, company sale, family company, working director
- connected persons
- close company, participator, extraction, company-to-individual transfer
- remittance basis, non-domiciled treatment
- CAT thresholds, CGT consequences, or a combined CGT and CAT problem

## How To Use The Overlay
1. Keep the selected module output contract.
   - Example: if Gerry says `use the report playbook`, still output `generated.report`.
   - Example: if Gerry says `use the education playbook`, still output `generated.education`.
2. Before doing arithmetic, identify the tax head or heads.
3. Test reliefs and qualifying conditions before computing tax.
4. Where relief only applies partly, calculate the qualifying proportion first.
5. If more than one relief may be relevant, compare them briefly in NOTES and use the correct one in the logic.
6. Treat rates, thresholds, exemptions, yearly limits, and lifetime caps as year-sensitive inputs.
7. If the cheat sheet is high-level or incomplete for that point, say so briefly in NOTES and avoid overstating certainty.

## Cross-Playbook Rule
The tax overlay can sit on top of any relevant playbook:
- `Report` for workbook-style tax scenarios or long-form tax notes
- `Education` for client-friendly tax explainers
- `Protection` only when a tax relief point is directly relevant

Do not force a tax scenario into PBS, Pension, Mortgage, or Loan unless Gerry explicitly wants those module types.

## Output Discipline
- Keep NOTES concise and decision-focused.
- Do not expose long legal derivations.
- Keep client-facing copy plain English and screen-share friendly.
- If tax-year parameters are missing, use the cheat sheet for logic but flag the missing year-sensitive inputs in NOTES.
