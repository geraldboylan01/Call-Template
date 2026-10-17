# Household Cash Flow Playbook

Use this playbook for `use the cash flow playbook`, `household cash flow`, or what is left after this year's tax, spending and pension saving. Use Net Retirement Cash Flow for a retirement funding gap instead.

## Job
Return `generated.householdCashFlowInputs`. The app runs the Irish tax calculator separately for every case, derives the figures and writes the summary. Do not calculate tax, a pension-relief rate, left over or a shortfall in the payload.

## Output
Use the usual NOTES and strict JSON sections. NOTES names each case's change and any missing facts. Emit only `householdCashFlowInputs` in `generated`; omit summary, assumptions, outputs, tables, charts and other module inputs.

## Example

```json
{
  "title": "Your household cash flow",
  "generated": {
    "householdCashFlowInputs": {
      "householdTaxStatus": "married_or_civil_partners",
      "people": [{ "id": "niamh", "label": "Niamh", "age": 45, "personalPensionContribution": 5000, "statedTakeHome": 50000 }, { "id": "dara", "label": "Dara", "age": 45, "personalPensionContribution": 3000 }],
      "income": [{ "personId": "niamh", "type": "employment", "amount": 75000 }, { "personId": "dara", "type": "employment", "amount": 75000 }],
      "outgoings": [{ "id": "mortgage", "label": "Mortgage", "amount": 30000 }, { "id": "car", "label": "Car loan", "amount": 6000 }, { "id": "living", "label": "Living costs", "amount": 48000 }],
      "scenarios": [
        { "id": "today" },
        { "id": "clear-car", "changes": [{ "type": "clearOutgoing", "outgoingId": "car", "paidFrom": "savings" }] },
        { "id": "pension", "changes": [{ "type": "extraPension", "amount": 10000 }] },
        { "id": "both", "changes": [{ "type": "clearOutgoing", "outgoingId": "car", "paidFrom": "savings" }, { "type": "extraPension", "amount": 10000 }] }
      ]
    }
  }
}
```

## Inputs
- All amounts are annual euros. Convert a stated monthly amount by multiplying by 12; do not guess an annual figure.
- `people`: one or two. Each `id` is unique and uses only lowercase letters, digits, hyphens or underscores (`^[a-z0-9_-]+$`); `joint` is reserved and cannot be a person id. Use stable ids such as `mary_jane`, with a separate display label. Integer `age` 16 to 110; `label` is required for two people and has 1 to 40 characters. Optional `personalPensionContribution` is today's annual gross personal contribution, finite and 0 or more, default 0, excluding employer contributions. Optional `statedTakeHome` is the bank amount after today's pension deduction, positive and less than gross; bank pay plus the current contribution cannot exceed gross. It sets the person's tax level; case changes still use the engine's difference. Ask for gross income as well.
- `householdTaxStatus`: optional; the app otherwise assesses separately. Use only the tax engine statuses: `single`, `married_or_civil_partners`, `widowed_or_surviving_civil_partner`. Do not infer joint assessment from living together.
- `income`: one to six `{ personId, type, amount }`, amount positive. Types: `employment`, `rentalProfit`, `statePension`, `occupationalPension`, `arfDistribution`. `personId: "joint"` splits equally; use individual ownership when known. Total gross must be at least €50, so it does not display as €0.
- `outgoings`: one to six `{ id, label, amount }`, amount 0 or more. Each id is unique and contains only lowercase letters, digits or underscores (`^[a-z0-9_]+$`); no hyphens. Reserved ids are `tax`, `pensions` and `left_over`. Each outgoing label has 1 to 24 characters. Tax is calculated and must never be a stated outgoing. Keep mortgage repayments, other loans and living costs separate where the cases need them.
- `calculationYear`: optional tax year; omit for the current year. Do not supply rates or tax figures.
- `scenarios`: one to four, unique `id`. The base is the first unless `baseScenarioId` selects another. The base has no changes.
- A `clearOutgoing` names an existing outgoing; optional `paidFrom` can only be `"savings"`. This stops the annual cost; it does not deduct a payoff from a savings balance.
- An `extraPension` gives a positive annual gross contribution. Optional `personId` names the payer; omitted/`joint` splits equally. Each case has at most one extra-pension change. Today's plus extra contributions must remain within each person's age/earnings relief limit; let the app validate it and never invent a relief percentage.
- Case `title` and `description` are optional; a supplied title has 1 to 40 characters. Prefer derived titles. A case has at most three changes in total: different cleared outgoings and at most one pension contribution. Three cleared debts plus an extra pension is four changes and is refused. Split excess changes into separate comparisons, or ask which three Gerry wants together; never silently drop a requested change.

## Current pension saving and bank pay
Every case includes `people[].personalPensionContribution`; `extraPension` adds to it. Do not also enter the current deduction in outgoings. When at least one case rounds to a contribution above €0, the Pensions chart column is reserved across cases. Contributions that display as €0 everywhere have no chart column but remain in the exact calculation. The visible row shows the full current-plus-extra gross amount, and the tax line carries the relief. The stated bank amount already has today's deduction taken off; the app does not subtract it twice.

Ask for current personal contributions when they are material to stated payslip pay or a pension-saving comparison. Never infer them from the difference between gross and net. Employer contributions stay outside household spending. A current or total contribution above the site's relief limit is refused; disclose that rather than bypassing it as a spending line.

A short case is valid. The screen says `Short` with a positive size; the ledger keeps the signed shortfall. Do not force left over to zero or copy rental video's wording into this module.

## Client-facing words
The same wording restrictions apply to every supplied text field: `people[].label`, `outgoings[].label`, and case `title` and `description`. Use first names for people, and speak to the client as `you` or `your` in the other text. Never use `they`, `their`, `the household`, `the couple`, `the client` or `clients`. Never recommend or rank (`we recommend`, `you should`, `best`, `ideal`, `optimal`) or abbreviate yearly amounts as `p.a.`. Write amounts with separators, such as `€1,000` rather than `€1000`.

Do not name providers in any of those fields, including AIB, Bank of Ireland/BOI, PTSB/Permanent TSB, Revolut, Zurich, Irish Life, Aviva, Davy or Standard Life. Do not copy account/provider names into labels or case descriptions. Prefer the app's derived case titles. If a supplied name or sentence cannot meet the validator, explain the conflict in NOTES and ask for suitable display wording rather than fabricate a person's identity.

Final expense-label authoring belongs to AI; do not build deterministic prose rewrites. The app refuses banned wording and wraps labels without changing their text.

This playbook describes the adviser Dev Panel workflow. It does not register a consumer planner adapter or claim that the future plan-pack ledger is implemented.
