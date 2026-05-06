# Prompt Pack README

This folder contains the zero-token prompt pack for the ChatGPT project workflow.

## Goal
- keep Gerry's live-call prompting style unchanged
- improve output quality and visual strength
- keep JS as the source of truth for repeatable maths
- avoid app downtime by changing prompts, not app code

## Files
- `MASTER_PROJECT_PROMPT.md`
  - single assembled file for the ChatGPT project
- `00_core_contract.md`
  - shared transport, precedence, ambiguity, and output rules
- `01_playbook_aliases.md`
  - preserves spoken playbook names and invocation style
- `02_schema_capability_matrix.md`
  - runtime reference source of truth
- `03_irish_tax_overlay.md`
  - cross-playbook rule layer for Irish tax scenarios
- `10_pbs_playbook.md`
- `11_pension_playbook.md`
- `12_mortgage_playbook.md`
- `13_loan_playbook.md`
- `20_education_playbook.md`
- `21_report_playbook.md`
- `22_protection_playbook.md`
- `irish_tax_ai_cheat_sheet_v1.1.md`
  - the tax logic source file to upload alongside the master prompt
- `90_examples_and_regression_prompts.md`
  - shadow test prompts and pass criteria
- `91_artifact_payload_examples.md`
  - representative JSON payloads for the upgraded artifact-style module capabilities

## Recommended Upload / Paste Strategy
For the live ChatGPT project, use `MASTER_PROJECT_PROMPT.md`.

Also upload `irish_tax_ai_cheat_sheet_v1.1.md` so tax scenarios can use the workbook logic directly.

Use the separate component files for maintenance, review, and future prompt tuning.

## Assembly Order
The assembled master prompt should include these files in this order:
1. `00_core_contract.md`
2. `01_playbook_aliases.md`
3. `03_irish_tax_overlay.md`
4. `10_pbs_playbook.md`
5. `11_pension_playbook.md`
6. `12_mortgage_playbook.md`
7. `13_loan_playbook.md`
8. `20_education_playbook.md`
9. `21_report_playbook.md`
10. `22_protection_playbook.md`

`02_schema_capability_matrix.md`, `03_irish_tax_overlay.md`, and `90_examples_and_regression_prompts.md` are maintenance/reference files. The live project should still use `MASTER_PROJECT_PROMPT.md`, plus the uploaded `irish_tax_ai_cheat_sheet_v1.1.md` file.

## Cutover Steps
1. Keep the current ChatGPT project prompt as a backup.
2. Upload `MASTER_PROJECT_PROMPT.md` and `irish_tax_ai_cheat_sheet_v1.1.md` into the new project.
3. Shadow-test the new pack using `90_examples_and_regression_prompts.md`.
4. Replace the project prompt with `MASTER_PROJECT_PROMPT.md` only after the new pack is clearly stable.
5. Keep the old prompt bundle available for at least one week after cutover.

## Success Criteria
- Gerry can still say `use the PBS playbook`, `run the pension playbook`, and similar short commands.
- JSON pastes into the current app without schema rejection.
- Mortgage, loan, and pension modules stay JS-backed.
- Education, report, and protection outputs become visually stronger and less repetitive.
- Tax scenarios use the uploaded cheat sheet as a logic overlay without forcing a separate tax playbook.

## Notes
- The current prompt pack now targets the upgraded structured artifact renderer in the app.
- The prompt pack corrects stale documentation where needed, especially the loan input path and unsupported report meta fields.
- The tax cheat sheet is now an explicit uploaded project asset, not an implicit memory from older instructions.
