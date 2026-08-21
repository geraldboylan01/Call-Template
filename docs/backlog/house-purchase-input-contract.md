# House Purchase: input generation cannot build a valid calculation input

**Status:** Phase 5 work — calculation/module contract, not conversation.

## What happened

Cross-module Phase 4 run `20260818T091741-house_purchase_medium-01`.

Everything conversational SUCCEEDED:

- capture: target price, savings, rent, spending, both incomes;
- ownership: EUR 62,000 to the client and EUR 48,000 to the partner, correctly
  separated — the case pension never exercised;
- readiness: `stillNeeded` empty, and recomputing readiness from the run's own
  canonical state gives `ready_with_assumptions`, `missing: []`, for both
  `house_purchase` and its `liquidity_analysis` companion.

The engine then throws on its own invariant:

    generated.housePurchaseInputs.cashSavingsContributions must total currentCashSavings

So `house_purchase` produced no result. `liquidity_analysis` — the companion —
completed, meaning the client asking to buy a home received a cash-reserve
analysis instead of a house purchase plan.

## The second defect: it fails silently

`confirm_and_run` returns `ok: false` with NO error code, because its result is
`ok: executed.analysisPlan?.status === 'complete'`. A module that throws during
execution is indistinguishable from any other incomplete plan. The harness
retried three times and recorded `code: null` each time; the diagnostics could
not say why, and neither could the client, who was told nothing useful.

Two things worth fixing in Phase 5:

1. the input contract itself — cash savings must decompose into contributions
   that total the holding, and a conversationally captured profile does not
   supply that decomposition;
2. the failure surface — a module that cannot run should say which module and
   why, so the conversation can ask for what is missing or say plainly that this
   analysis is not available.
