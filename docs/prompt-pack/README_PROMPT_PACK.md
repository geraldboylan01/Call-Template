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
- `10_pbs_playbook.md`
- `11_pension_playbook.md`
- `12_mortgage_playbook.md`
- `13_loan_playbook.md`
- `20_education_playbook.md`
- `21_report_playbook.md`
- `22_protection_playbook.md`
- `90_examples_and_regression_prompts.md`
  - shadow test prompts and pass criteria

## Recommended Upload / Paste Strategy
For the live ChatGPT project, use `MASTER_PROJECT_PROMPT.md`.

Use the separate component files for maintenance, review, and future prompt tuning.

## Assembly Order
The assembled master prompt should include these files in this order:
1. `00_core_contract.md`
2. `01_playbook_aliases.md`
3. `10_pbs_playbook.md`
4. `11_pension_playbook.md`
5. `12_mortgage_playbook.md`
6. `13_loan_playbook.md`
7. `20_education_playbook.md`
8. `21_report_playbook.md`
9. `22_protection_playbook.md`

`02_schema_capability_matrix.md` and `90_examples_and_regression_prompts.md` are reference files and are not required inside the live master prompt.

## Cutover Steps
1. Keep the current ChatGPT project prompt as a backup.
2. Shadow-test the new pack using `90_examples_and_regression_prompts.md`.
3. Replace the project prompt with `MASTER_PROJECT_PROMPT.md` only after the new pack is clearly stable.
4. Keep the old prompt bundle available for at least one week after cutover.

## Success Criteria
- Gerry can still say `use the PBS playbook`, `run the pension playbook`, and similar short commands.
- JSON pastes into the current app without schema rejection.
- Mortgage, loan, and pension modules stay JS-backed.
- Education, report, and protection outputs become visually stronger and less repetitive.

## Notes
- This prompt pack does not change the app code.
- The prompt pack corrects stale documentation where needed, especially the loan input path and unsupported report meta fields.
