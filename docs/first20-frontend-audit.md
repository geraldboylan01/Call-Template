# First 20 frontend readiness audit

Audit date: 6 September 2026. This records local frontend evidence, not a production launch approval. The browser run used the real `/plan/` HTML, CSS, JavaScript, controller and HTTP adapter with an in-memory, synthetic HTTP fixture. It made no OpenAI calls and used no real client information. The fixture supplied conversation and result payloads; it did not test planner reasoning or financial calculations.

## Changes completed

- Type stores its private activation/request identifiers before creating a meeting. Retrying a lost creation response reuses that activation; refreshing an established meeting reads its original lease instead of reserving another budget.
- A saved Type meeting resumes directly. A refresh does not invite the client to open a second lane while the first meeting owns the reservation.
- Execution status is polled while work is pending. A lost approval response or transient results read can reach the matching, current results without another client message.
- Session and controller generation checks discard late responses after the client leaves, deletes their session or starts another. Type closes before the application deletes session access, and consent withdrawal removes its saved control details.
- The shared completion check requires the current plan, revision and analysis identity. Existing results from another execution cannot finish the current meeting. Completed sessions open their results on reload.
- Type failure screens keep the saved conversation available to copy and use planning-session wording.

## Automated evidence

Commands executed successfully:

```sh
node scripts/check-first20-frontend.mjs
node scripts/check-live-completion-frontend.mjs
node scripts/check-consumer-voice-frontend.mjs
```

The focused frontend suite passed 20/20 checks using real frontend modules, a small DOM shim and synthetic HTTP responses. Its cases cover duplicate starts, abandonment during creation, activation replay after a lost response, restarting after a late close, transient completion reads, failed-message draft recovery, lost approval responses, ending an in-flight message, empty choice placeholders, delayed execution, restored transcript/card state, session changes, stale analysis identity, late session reads, results reload, application deletion ordering, consent cleanup, preventing reactivation after consent withdrawal, retaining completed results after withdrawal and Type failure transcript rendering.

The completion suite checks matching results, delayed observation, delivery ordering and shutdown. The voice frontend suite passed its active live-call transcript, typing, failure, SDP and accessibility checks. These are not evidence of a real microphone or audio connection.

## Actual browser evidence

The Codex in-app browser loaded the real `/plan/` frontend against loopback servers on ports 8788 (assets) and 8787 (synthetic HTTP responses). The temporary fixture was `/tmp/planeir-first20-browser-fixture.mjs`; it is not a shipped application route.

| Check | Observed result |
| --- | --- |
| Initial Type screen | Conversation, money input, ownership choice, labels, Send and Save these rendered. |
| Refresh while collecting | Original transcript and input card returned. Fixture recorded one meeting creation in total. |
| Save synthetic input card | Values submitted as a conversation turn; read-back and approval question appeared. |
| Refresh while awaiting confirmation | Transcript restored and approval could continue. |
| Drop the approval HTTP response after accepting it | Client showed reconnect/error feedback, read durable status, observed executing then complete, and navigated to results without another input. |
| Matching results | Rendered the synthetic financial-overview card with formatted Gross assets and Net worth values. This checked presentation only. |
| Reload completed results | Results appeared immediately; no new meeting was created. |
| Mobile, 390 × 844 | Composer, conversation and result card remained readable and operable. Document width and scroll width both measured 390px on the conversation and results views. Temporary viewport override was reset after testing. |

## Remaining limitations and issues

No unresolved P1 was reproduced in the tested Type creation, refresh, approval-recovery, results and session-isolation paths. This does not certify first-20 readiness by itself.

- **P1 evidence gap:** a real deployed Speak journey, actual microphone permission denial, audio delivery and real mobile Safari/Chrome behaviour were not exercised in this frontend audit. Backend/provider proofs and a human device check must cover those before claiming voice readiness.
- AI-consent withdrawal now ends both conversation transports, displays an explicit stopped-state explanation and prevents lane creation on reload. Completed results remain accessible. These application behaviours were verified by the automated frontend checks; a real deployed withdrawal remains part of the manual release check.
- **P2:** abruptly destroying the approval response socket caused the browser to replay the request once, and the simple HTTP fixture appended a duplicate approval turn. Execution idempotency belongs to the backend checks; this browser run cannot prove production message-transcript deduplication.
- The tests did not measure screen-reader announcements, mobile virtual-keyboard overlap, slow real cellular networks, browser storage-denial behaviour, cross-browser rendering or long-session memory use. No production client sessions were opened or deleted.

## Manual release check

1. On the intended deployed build, open a disposable synthetic invitation, choose Type and send a goal. Reload while a card is visible; confirm the conversation returns and no second meeting reservation appears.
2. Fill a card, ask for a correction and verify that the corrected owner, amount and period appear in the read-back. Confirm once, temporarily interrupt the connection, restore it and verify that exactly the matching results appear without another approval.
3. Reload the completed session. Verify the results open directly. Start a separate disposable session while an earlier response is delayed; confirm no earlier text or results appear in the new session.
4. During Type, withdraw AI consent. Confirm no further AI turns run, the screen explains the stopped state accurately and reload does not silently reactivate AI. In another disposable session, delete the session and verify that the conversation closes and cannot reappear through a late response.
5. Repeat the core Type path at a real phone width with the virtual keyboard open. Check every control, focus movement, scrolling and result card.
6. Complete one real Speak journey in the target browser/device, including permission denial and reconnection, before treating the separate voice lane as tested.

## Final automated addendum

The focused suite now passes 21/21 after adding the card-action identity regression. The browser sends the current brief's `unknownFieldId`, while a separate opaque field/entity identity preserves unfinished drafts for the same field. This final token correction was covered by controller and real-D1/DO recovery tests after the browser run; the actual browser observations above remain those of the 20-check stage. See [backend validation](first20-backend-validation.md) for stale-card, eviction and later-uncertainty evidence.
