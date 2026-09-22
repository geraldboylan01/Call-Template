# Load a whole call from one case-pack file

## Context

The Dev Panel in the advisor workspace (`#devPanel` in `app/index.html`) applies one module payload at a time. The path is `applyPayloadFromEditor`, then `normalizeEditorJsonInput` (`js/dev_payload_input.js`), then `normalizeDevPanelPayload` (auto-repairs, with warnings), then `applyModuleUpdateInternal`, which runs `normalizePayload` and `preflightGeneratedPayload` before `applyNormalizedPayloadToModule` also runs the engine for engine-backed modules. All of that lives in `js/app.js`.

I'm starting to prepare complete calls outside the app. An Ask About Money case becomes six to ten modules (balance sheet, liquidity, retirement, mortgage, report modules and so on), and pasting them one by one is slow and error-prone. I want one file that loads the whole call, and a Node command that checks a file with exactly the code the Dev Panel uses, so a pack that passes the check can't fail in the browser.

## Before you write code

- Pull `main` and create a new branch, for example `case-pack-import`. The checked-out `pbs-module-layout` branch is already merged into main.
- Read the functions named above, plus `handleNewCall` and `replaceSession` in `js/app.js`, and `newSession` and `importSession` in `js/state.js`.
- Then give me a short plan, including where the extracted pipeline module will live and what moves into it. Wait for my go-ahead before implementing.

## Case pack format, version 1

```json
{
  "casePackVersion": 1,
  "clientName": "AAM: username",
  "modules": [
    { "title": "Your balance sheet", "generated": { "summaryHtml": "<p>...</p>", "outputsBucketed": {} } },
    { "title": "Your cash reserve", "generated": { "summaryHtml": "<p>...</p>", "liquidityPlan": {} } }
  ]
}
```

- `casePackVersion`: required, must be `1`.
- `clientName`: required non-empty string. It becomes the session's client name.
- `modules`: required, non-empty array. Each entry is exactly a Dev Panel payload as accepted today. `moduleId` is rejected inside a pack, because every module in it is new.
- Unknown top-level keys are rejected.

## Dev Panel behaviour

- Treat the input as a pack when the parsed JSON has `casePackVersion` and `modules`. Anything else behaves exactly as today.
- Validate the whole pack before touching the session. Every module goes through the same repair, normalise and preflight path as a single paste. If any module fails, nothing changes and the error names the module and the reason, for example `Module 3 of 7 (Your retirement): generated.pensionInputs.rentalIncomeScenarios supports at most 4 cases; received 5.`
- Once a pack validates, offer two actions:
  - Start a new call from the pack: the same confirmation `handleNewCall` shows when the open session has modules, then a fresh session named `clientName` holding the pack's modules.
  - Add to this call: append the modules after the existing ones.
- Modules keep the pack's order and the first new module becomes active. Render once at the end instead of animating each module in.
- List auto-repair warnings per module in the existing warnings area. The toast says how many modules loaded and how many repairs were applied.
- Add a `Load case pack file` button that reads a `.json` file, since packs are too long to paste comfortably. Pasting a pack into the textarea still works.
- If saving the session fails (for example on the browser storage quota), roll back to the previous session and say so.

## Shared pipeline and the Node check

- Move the parts of the single-payload pipeline that don't need the DOM (`normalizeDevPanelPayload`, `normalizePayload`, and the validation and engine run inside `preflightGeneratedPayload` and `applyNormalizedPayloadToModule`) into a module with no DOM or `window` dependency, imported by `js/app.js`. Single-payload behaviour must not change.
- Add `scripts/check-case-pack.mjs` with an npm script `check:case-pack`. Usage: `node scripts/check-case-pack.mjs <file.json>` for a pack, or `--payload <file.json>` for a single Dev Panel payload. For each module it prints OK, the auto-repairs applied, or the error, and it exits non-zero on any failure.
- With `--summary`, it also prints each module's headline figures, per case where the module has cases, using the same engine calls the renderer uses:
  - PBS: gross assets, total liabilities and net worth for every case, plus a reconciliation check (each section subtotal equals its rows, gross assets equals the four asset subtotals, net worth equals gross assets minus total liabilities). A case that doesn't reconcile is a warning, and a failure with `--strict`.
  - Liquidity: months of cover, target, surplus or shortfall.
  - Retirement: required pot and projected pot at retirement.
  - Mortgage and loan: interest saved and payoff date.
  - Net retirement cash flow: required net fund and available fund.
  - College funding: the funding range.
  - Report and education: block and visual counts.
- Plain text by default, `--json` for machine-readable output.

## Tests

- Fixtures in `scripts/fixtures/case-packs/`: one valid pack covering PBS with three alternatives, liquidity, retirement with cases, mortgage with cases and a report module; and invalid packs for a fifth case, a duplicate case id, a `moduleId` inside a pack, a wrong `casePackVersion`, an empty `modules` array, and malformed JSON.
- A check script asserting the valid pack passes, each invalid pack fails with the expected message, and the Dev Panel path and the Node check call the same validation function.
- `npm run build` and the existing checks still pass.

## Out of scope

- Do not edit `docs/prompt-pack/`. The case-pack format gets documented there separately once this lands.
- No backend, client pipeline, published session or consumer changes. Module `notes` are not part of a pack.

## When you finish

End with the final format (every key and every error string) and the exact `check:case-pack` usage and output shape, including the `--json` schema, so the Cowork workflow can call it. Keep to the repo's commit style: short plain-English commits describing what changes for the person using the app.
