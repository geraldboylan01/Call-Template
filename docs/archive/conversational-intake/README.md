# Conversational intake: retired 27 October 2026

The product now goes from forms to a completed analysis. Voice and typed AI
meetings are no longer an app entry point or a prerequisite for generation.
Do not restore them as an automatic fallback when analysis is unavailable.

## What was retired

- Desktop and mobile adviser “Test Planner” launchers and their invite requests.
- The `/plan/` conversation shell, microphone controls, Speak/Type choice,
  onboarding and transcript UI. Old links show a static notice with links to
  the form and saved information. Their invite fragments are not forwarded.
- The call analytics dashboard and its navigation links.
- Production beta activation, including standing keep-active settings and
  manual paid activation inputs. Future deployments resolve the beta dormant.

The old plan page, analytics page, adviser-launcher check and deployment workflow
are saved here as `.txt` snapshots. `js/plan/` remains historical source so its
tests and experiments can still be inspected. The Pages build excludes that
directory and the analytics controller. None of these snapshots is published.

Backend conversation code, database migrations and existing records are retained
for reference and data lifecycle support; this change does not delete customer
records. Worker conversation capabilities remain dormant in production config.
The retired privacy notice stays accessible for earlier participants. This is
a source change and takes effect on the live site only after deployment.

## Lessons to carry into forms-to-analysis

1. **AI interprets; engines calculate.** Let the analyst choose relevant routes
   and ask for missing facts. Every displayed financial result comes from the
   native calculation engines, with dated assumptions and provenance.
2. **Review the interpretation independently.** Validate ownership, units,
   omitted versus explicit-zero facts, and assumptions. An attractive narrative
   cannot make an unsupported financial input valid.
3. **Bind results to the confirmed revision.** Editing information invalidates
   old readiness and approval. Retries must not publish a stale plan as current.
4. **Completion requires real, displayable results.** A finished request or
   successful AI response alone does not mean the analysis is complete. Preserve
   partial results and say clearly which parts could not be calculated.
5. **Budget repair and retries.** The earlier recovery experiments found that
   eventual certification could still take too long for the interaction. Measure
   complete user journeys, including failures, rather than only model responses.
6. **Keep the delivery channel separate from planning.** Forms are the input
   channel now. Reuse financial contracts, verification and calculation tools,
   without importing microphone, speech, transcript or meeting state.
7. **Keep release checks aligned with the actual product.** A deployment proof
   for a retired entry screen should not block the new form journey or reactivate
   the old beta.

## Evidence and implementation map

- [AI author/verifier experiments and limitations](../../ai-led-route-forward.md)
- [Earlier AI-led evidence](../../evidence/ai-led-baseline-2026-09-11/README.md)
- [Historical consumer operations](../../consumer-journey-operations.md)
- [Historical voice operations](../../consumer-realtime-voice-operations.md)
- [Current form and confirmation boundary](../../demo-access.md)
- `js/planning/`: reusable profiles, module contracts and deterministic engines.
- `worker/src/consumer/`: retained interpretation, verification and lifecycle code.
- `js/results/`: active read-only presentation, independent of conversation state.
- `npm run check:form-journey -- --dist`: retirement and published dependency checks.

The missing generation bridge is still real work: confirmed form information
must become a complete household profile, the analyst must produce checked
routes and explanations, and the app must save and return the completed plan.
