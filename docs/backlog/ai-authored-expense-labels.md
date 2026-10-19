# Expense labels: AI authoring decision

Recorded 17 October 2026, from Gerry's instruction in the PR follow-up session.

Expense labels should be written by the AI at the final authoring stage. Do not implement deterministic code that rewrites, shortens, recategorises or otherwise manipulates natural-language labels. Gerry has found that approach fragile and does not want it introduced here.

The intended presentation is short, familiar descriptions of what the money is for, such as Mortgage, Car loan, Living costs and Childcare. These examples guide the AI; they are not a code-based mapping or a fixed category list.

No implementation is approved yet for the proposed label-authoring changes or additional label restrictions. Keep this as a design note for the final AI authoring work. In a later reply on 17 October, Gerry separately approved fixing text positioning now; that work must preserve the supplied labels and must not introduce deterministic language rewriting. Do not silently truncate a supplied label or invent a replacement.

## Evidence to retain

PR #71 exposed a compact-layout edge case during review. In the real app at a 320px viewport, its module is 252px wide. A synthetic 24-character unbroken label (24 W characters) occupies four rendered lines; the attempted line-count estimate allowed three. Selecting the car-loan-cleared case exposed a 16px text overlap. This is a label/layout issue with an ordinary €150,000 combined-income sample, not a million-euro salary or an axes problem.

The estimated-wrapping patch was not pushed. The final #71 fix measures rendered label height and positions text accordingly; its narrow-layout regression checks include the unbroken label. #71 is now merged. This history remains evidence for the AI-authoring brief, not an open merge blocker or permission to rewrite labels.

The separate finite-total overflow and provider-refusal fixes also merged with #71. They do not rewrite language. No change to the household's amounts, case logic, tax or engine rounding is part of this labelling decision.
