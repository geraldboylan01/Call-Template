# Browser validation — 6 September 2026

The actual Codex in-app browser rendered the repository's `/plan/` HTML, CSS, JavaScript, controller and HTTP adapter against a **synthetic local backend**. The temporary fixture at `/tmp/planeir-first20-browser-fixture.mjs` served assets on `localhost:8788` and invented response payloads on `127.0.0.1:8787`. It made no OpenAI calls and contained no real client data. This validates browser behaviour, not provider reasoning, backend execution idempotency, financial calculation correctness or production readiness.

Observed passes:

- Type loaded its conversation, money/ownership card, accessible labels and submission controls.
- Refresh restored the original transcript and card; the fixture logged one meeting creation total.
- Saving the card produced a client turn and an approval read-back. Refresh at the approval point retained the conversation.
- The fixture accepted approval and deliberately dropped its HTTP reply. The frontend recovered `executing` then `complete`, navigated to the matching result, and needed no further client input.
- Reloading the completed session opened results immediately, without creating another meeting.
- At 390 × 844, conversation/composer and results remained readable and operable. Both views measured a 390px document width and 390px scroll width. The temporary viewport override was reset.

Screenshots of the mobile conversation and mobile results were inspected inline during the browser run. **No filesystem screenshot path was produced by the CUA capture API in this run**, so there is no local screenshot artifact to cite. This report does not imply one exists.

The fixture's abrupt socket close was transparently retried once by the browser, producing duplicate approval text in that fixture. Whether production message transcripts deduplicate transport replay is unproven here; separate backend tests must establish that calculations still execute once.

Not tested in an actual browser: real voice or microphone permissions, deployed consent/deletion, virtual-keyboard overlap, screen-reader output, real mobile Safari/Chrome, denied tab storage and prolonged cellular outages. Consent/deletion/session-isolation behaviour is separately covered by the 20/20 synthetic-DOM frontend regression checks documented in [the frontend audit](first20-frontend-audit.md).
