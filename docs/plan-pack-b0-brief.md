# B0: plan pack v1 — implementation brief

Prepared 17 October 2026 against the implementation plan in #56. This brief specifies the format, validation, deterministic module compilation and command-line check. It does not author a client plan or implement the later planning stages.

## Outcome

An adviser or AI author writes a versioned JSON pack with household facts once, a current position, up to three alternative routes, goal flexibility and the chapters to show. A local command validates the pack, compiles each chapter's engine input and runs the existing engines. The output identifies which route maps to which module case and where every input came from. Narration resolves only registered placeholders against computed results.

Use the existing case-pack contract and module input validators as the final boundary. A plan pack is a separate authoring format; do not silently reinterpret an ordinary module payload or a case pack as a plan pack. Keep consumer activation off.

## Boundaries between stages

- **B0:** pack format and normalizer, compiler, case mapping, engine dispatch, diagnostics, placeholders and fixtures.
- **B1:** allocate resources, protect the emergency reserve, price goal funding in the method's fixed order, test route balance and produce the resource ledger. B0 must not claim a route is affordable or balanced merely because its chapters compile.
- **B2:** automatic profile adapters and any missing profile questions; current pension contributions (stated take-home is the amount reaching the bank after the current pension deduction); central illness-scenario rates, tax treatment and duration support. Existing approved adapters may be reused where their input contract is complete, but B0 must not invent facts to fill a missing adapter.
- **B3:** route-linked plan screen, client reopening and presenter behaviour.
- **B4:** final AI authoring playbook. Expense-label wording belongs here under the recorded AI-authorship decision; no deterministic text rewriting is part of B0.

## Pack contract

Freeze the exact JSON schema in the implementation PR and keep it in one module imported by the checker and compiler. Version 1 contains:

| Field | Contract |
|---|---|
| `planPackVersion` | Exactly `1`; unknown versions fail before compilation. |
| `clientName` | A non-empty display name; never used to infer household facts. |
| `calculationDate` | A valid ISO calendar date, supplied explicitly. All chapters use this date and its year. |
| `household` | One normalized household profile v1. Preserve owner IDs, money currency and gross/net basis. |
| `planningInputs` | Only the additional stated facts that existing profile adapters cannot yet supply. Declare their exact paths, owners, units and basis in the schema; never accept a free-form bag of per-chapter payloads. |
| `goalFlexibility` | Bounds keyed by existing goal ID. Bounds must be supplied by the author from client-stated flexibility, not guessed by the compiler. |
| `routes` | One current route plus zero to three alternatives. Unique stable IDs; `current` first, with no changes. Preserve input order without ranking. |
| `chapters` | A non-empty list of distinct supported chapter identifiers, in display order. An unsupported chapter fails by name and route. |
| `narration` | Text templates keyed by route ID, using registered placeholders only. No typed financial amounts, percentages or computed results. |

`planningInputs` is a transition contract, not a second household: a field already represented in the canonical profile must be referenced there. For example, annual left-over may be stated until the cash-flow adapter is available; it must not also be restated in each goals chapter. A protection State payment remains a stated input until the approved central illness adapter is built. Do not silently insert the researched gross maximum as spendable income.

Do not accept `goalOrder` or `goalPriorities`. Do not add client-selectable provider, product, premium or recommendation fields. Do not implement deterministic paraphrasing of labels or narration.

## Routes and changes

Allow only the three approved change families: use cash on a goal (`useCash`), move a goal within stated bounds (`moveGoal`), and clear an outgoing from savings. Each change must name an existing goal or outgoing by stable ID. Unknown fields, duplicate conflicting changes, negative amounts, invalid ages/dates and out-of-bounds changes fail at the precise JSON path.

The schema must define the outgoing-clearing change name and fields once, matching the existing cash-flow engine semantics. Translate at the engine boundary rather than creating a second repayment calculation. For `useCash`, the approved amount forms are a positive whole-euro amount, `whole`, or `remaining`.

`whole` and `remaining` require B1's resource allocation. In B0, parse them as known instructions and return an explicit `requires_resource_ledger` diagnostic where their numeric resolution is needed. Do not substitute zero, spend the same cash twice or manufacture a balanced route. The same rule applies to reserve-dependent route allocation. This makes the incomplete stage visible without implementing B1 inside the compiler.

## Compilation

1. Normalize and validate the pack without mutating it. Build one immutable current-position context from the household, stated transition inputs and calculation date.
2. Resolve each route independently from that same context. Never apply route 3 on top of route 2. Record each changed fact and its source pointer.
3. Build engine inputs through explicit per-chapter builders. Reuse approved existing adapters and tax functions; no mortgage, pension, tax or college arithmetic may be copied into the compiler.
4. Dispatch only to engines on `main` with an input builder whose contract is implemented. Unsupported or incomplete chapter wiring must return an actionable diagnostic, not a successful empty chapter. Property chapters remain outside version 1.
5. Normalize the resulting module payload through the existing module pipeline, derive its outputs and retain engine diagnostics. Never trust author-supplied tables, charts, goal states or summary figures.
6. Deduplicate distinct settings per chapter using normalized financial inputs and the shared calculation date, without case titles or narration influencing equality. Map every route explicitly to its chapter case ID. One chapter may have fewer cases than routes; none may exceed four cases.
7. Return compiled modules, route-to-case mappings, unresolved-stage diagnostics, provenance and the assumption/tax-rule versions. Keep inputs and results separate.

The goals engine already derives its own cases. Its builder must reconcile a route with an existing derived case or report that a route needs a later adapter; it must not inject authored scenarios into `goalsAndResourcesInputs`, choose the nearest case or relabel a financially different case as the route.

## Narration and labels

Maintain a small explicit placeholder registry, each with an owning result path, type and formatter. Initial placeholders describe computed chapter results and route changes. Reject unknown paths, unclosed placeholders, missing values and references to another route's result. Do not evaluate expressions or arbitrary object traversal from template text.

Validate typed narration values as a contract: amounts, percentages, goal-state claims and dates representing calculated results belong in placeholders. The AI writes the sentence and expense-category wording; deterministic code substitutes validated values and escapes output for its destination. It must not rewrite prose, invent a shorter label or repair an unsupported financial claim.

## Checker and output

Add `npm run check:plan-pack -- <path>` using a local Node script and no model calls or paid services. It must:

- print the pack version, calculation date, chapter/route mapping and each chapter's compilation result;
- show the source of transition inputs and central assumption versions;
- distinguish **compiled**, **invalid** and **requires a later stage**;
- exit nonzero for invalid input, an engine refusal, an unsupported chapter or a required unresolved stage;
- never print `balanced`, `affordable`, `covered` or `recommended` as a plan-level conclusion before B1 supplies the corresponding evidence;
- support a machine-readable result without overwriting the source pack or an existing output file without an explicit output option.

The full end-to-end ledger printing described in #56 arrives with B1. B0 diagnostics must make this absence clear.

## Required evidence

Use small fixtures whose financial results are compared with direct calls to the existing engines, rather than hard-coded current tax amounts. Cover:

1. A current route and an unchanged alternative map to the same chapter case.
2. Two routes changing the same goal are compiled from the same baseline, not accumulated.
3. Exactly four distinct chapter cases work; a fifth route or case fails.
4. A route change outside goal flexibility, an unknown owner/goal/outgoing and duplicated household facts fail with their paths.
5. Missing take-home or left-over facts are reported, not estimated silently; a gross amount cannot be reused as net.
6. `whole`/`remaining` and reserve-dependent allocation return the explicit B1 diagnostic until the ledger is present.
7. A malformed engine input fails preflight and does not leave a partial successful plan.
8. Narration resolves only registered results for its own route; typed figures, unknown placeholders and markup injection are rejected or escaped as appropriate.
9. Calculation date and versioned assumptions remain the same across all chapter calls; rerunning the same pack against the same versions gives identical financial output.
10. The checker handles existing case packs through their existing path and never mistakes them for plan packs.

## Delivery

One implementation PR for B0, with a valid small pack, invalid fixtures, checker output and the schema/contract summary for later AI authoring. Keep prompt-pack rollout, B1's allocation, B2's new consumer questions and B3's screen in their own changes. The brief itself is documentation; merging it does not activate a compiler or consumer feature.
