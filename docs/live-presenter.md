# Live Presenter V1

Planéir exposes real presentation targets and executes a package. Codex reads the case, writes the complete script, directs a restrained set of visual beats, records a source-grounded review, validates the package in the live app and generates the annotated script. There is no model/API key inside Presenter Mode.

## Automatic discovery and authoring

1. Read forum material, every supplied module JSON, and the script/style reference. Write the case understanding and complete `script.md` before selecting visual beats.
2. Run automatic discovery using the ordinary import pipeline. A case pack or a session JSON is accepted:

   ```sh
   node scripts/presenter-package.mjs prepare path/to/case-pack.json private/aam-makeovers/my-presentation
   ```

   This writes `session.json`, `catalogue.json`, `live-presenter-brief.json`, and a local preview bootstrap. `discover <source> [output-directory]` produces the catalogue/brief without a preview. No manual target export is required.
3. Reread the finished script alongside the catalogue. Choose targets by their concept, label, description, values, scenario and output origin. Let one FRAME last as long as it helps comprehension. Report missing/uncertain mappings in `unmapped`.
4. Create `presentation.json`; use `fingerprint(script)` from `js/presenter_catalogue.js` for `scriptHash` and the catalogue's case fingerprint. Every beat needs a stable ID, presenter label, operations, rationale, and one exact, unique script anchor. An operation can only select a discovered target or an existing named scenario. There is no arbitrary selector, script execution, input override or financial calculation action.
5. Run `node scripts/presenter-package.mjs validate private/aam-makeovers/my-presentation`. This compiles the package and writes `script-presenter.md` and `validation-structural.json`. It deliberately does not claim live validation has happened.
6. Serve the repository from its root with `node scripts/serve-presenter.mjs 8788`, then open `http://127.0.0.1:8788/private/aam-makeovers/my-presentation/`. This is the actual app shell importing `initApp` and the production controller, with a local, read-only case bootstrap. Private case files are excluded from the build and Git.
7. Run `await window.planeirPresenter.validateLive()` or use **Controls → Validate live**. Retain the returned JSON, review the live views, fix failures, then regenerate the annotated script from the validated package. Do not invent a substitute visual for a missing target.

In an already loaded advisor case, `window.planeirPresenter.discover()` returns the whole-case catalogue, and `.brief()` adds authoring instructions. These are read-only interfaces for local/browser tooling. The **Export presentation targets** button is a debugging fallback. The **Presenter Mode** button accepts `presentation.json` and `script.md` separately or together. Start preview stays disabled until both files pass validation; an invalid replacement clears the previously loaded package. It rejects a different or edited case.

The catalogue identifies modules by content revision rather than import-time UUID. It includes hidden-card availability, descriptions, output origins, scalar values, report block/item hierarchy, PBS holdings in each named scenario, repayment facts from the existing engine, timelines, and authored report chart points. It distinguishes authored reports from calculator outputs and declares that STATE does not recalculate other modules.

## Package shape

```json
{
  "version": 1,
  "id": "case-video",
  "title": "The financial question",
  "caseFingerprint": "from discovery",
  "scriptHash": "fingerprint of the complete spoken script",
  "steps": [
    {
      "id": "understand-the-tradeoff",
      "label": "THE TRADE-OFF",
      "rationale": "The visual change explains why the choice matters.",
      "operations": [
        { "action": "state", "target": "exact discovered module target", "scenarioId": "existing-case-id" },
        { "action": "focus", "target": "exact discovered result in that scenario", "emphasis": "spotlight" }
      ]
    }
  ],
  "cues": [{ "stepId": "understand-the-tradeoff", "before": "An exact unique passage in script.md" }],
  "narrativeReview": {
    "status": "passed",
    "claims": [{
      "quote": "An exact claim in the script",
      "targetIds": ["a discovered source target"],
      "facts": [{ "targetId": "a target with a scalar value", "value": 123 }],
      "assessment": "Why the source supports this claim, including rounding and qualifications.",
      "status": "supported"
    }],
    "scenarioIndependence": "Explain which scenarios and reports are independent.",
    "assumptionsAndCaveats": "Explain what remains assumed, unverified or unmodelled."
  },
  "unmapped": []
}
```

The strings above are schema examples; substitute discovered IDs. `sourceFiles` is an optional list for provenance. A `{action: "sequence", id, label, steps: [...]}` groups beats; its children each have a cue. Operations *within* a beat do not add cues. Timeline events, chart points, table rows and disclosures are FOCUS targets; opening their module, selecting its existing case, waiting for its actual animation, scrolling, opening a disclosure and highlighting happen in the same cue.

FRAME clears previous emphasis and puts the live component in view. FOCUS positions a component, opens an existing disclosure or selects the actual Chart.js data point/tooltip. RESET returns to the wider module and default disclosure state while retaining the selected named scenario. FRAME on a whole HTML timeline reflows its existing nodes into a readable overview; at limited height it shows dates/titles, with full text restored when focusing an event. No charts, values or slides are recreated.

## Script-led attention and motion

Codex chooses the visual treatment after rereading the completed script. The catalogue exposes `supportedEmphasis` and `suggestedEmphasis` for each target. FOCUS has an optional, validated `emphasis` field:

- `spotlight`: a soft fall in surrounding contrast leaves the actual target fully legible, with a fine edge of light. Useful for an area, a timeline turning point or an assumption disclosure.
- `underline`: a fine warm line under the existing value, with gentler surrounding dimming. Useful for one holding or figure. It uses the actual value element when available, otherwise the selected row/card.
- `point`: a small halo and guide anchored to the real chart point, retaining its native tooltip and full chart context. Only an existing `chart-point` target supports it.

The field defaults to the semantic suggestion and is preserved on LEFT navigation. The script determines when attention changes; treatments do not create new cues or run on a narration timer. Hold FRAME for long explanations. Add FOCUS only when isolating an idea improves comprehension. Do not use a light merely because a spoken number has a target. There are no looping pulses, fabricated labels, enlarged data marks or changes to chart scales.

Module navigation uses a short native dissolve of the existing stage, with the camera/HUD outside it. Only mounting/painting occurs inside the browser's transition callback; actual chart/scenario animation completion is awaited afterwards to avoid browser render-suppression deadlocks. Browsers without View Transitions use a fade fallback. Scrolling within a report follows a bounded, eased path; a compound STATE + FOCUS does not first scroll back to the module top. Reduced-motion preferences disable travel and fades. Attention follows scrolling/resizing, disappears during the temporary UP overview, and clears on FRAME/RESET/exit.

## Controller and state boundaries

`window.planeirPresenter` exposes `discover`, `brief`, `load(package, script)`, `start`, `next`, `previous`, `goTo(index)`, `restart`, `state`, `validateLive`, `canRecord`, and `exit`.

The ready position is index -1. The first RIGHT ARROW consumes cue 1. Starting recording does not advance a cue. At the end, RIGHT remains at the end; LEFT from cue 1 returns to ready. LEFT reconstructs the destination beat's complete named-scenario map and visual/disclosure state, rather than attempting to reverse incidental DOM effects. Busy transitions cannot consume a second cue. Failed resolution leaves the cue unconsumed and attempts to restore the preceding view; the error remains visible.

Entering Presenter Mode keeps the original session and maps, creates a disposable session and maps, renders read-only, and blocks persistence wrappers. Pending saves retain their original session reference. Existing named scenario APIs and animation callbacks operate only on the copy. Undeclared pension-max and local house-purchase what-if overrides are cleared in the copy. Exiting restores the original session, maps, focus/overview mode and scroll. No review status is approved or changed by the presenter controller. Compare mode must be closed before entering.

Preview and recording use this same controller. The recording core in `js/video_capture.js` is shared by Live Presenter and the existing Video Composer. It uses browser display capture plus a required live microphone, optional mirrored camera, AudioContext mixing, native MediaRecorder and a local WebM download. It has no upload path. Capture cancellation, stop-sharing, microphone loss and exit release the capture tracks. A partial usable recording is retained on a recorder failure. Camera framing is centred in V1; the older bespoke page's optional smart face crop is not migrated.

## Separate camera and screen recording

The default production workflow is **Record for editing · iPhone + OBS**. OBS captures the clean Planéir window plus the external Mac microphone; the iPhone records locally. Planéir does not start, stop or verify those external recorders. See [the recording guide](presenter-recording.md) or the in-app `app/recording.html`.

After validation at the capture size, Start clean take restarts at ready, shows a countdown and visible SYNC reference, then hides HUD, camera inset, emergency control and cursor. RIGHT/LEFT use the same controller. M marks a retake; C opens controls and logs that interruption; S ends only the take log. Validation is blocked while the take runs. A downloaded ZIP contains actual request/arrival/failure events, repeated visits, timestamps relative to SYNC, a timed script, editorial guide and the original package/validation. These browser event times are not encoded timecodes. Align the footage by shared audio; locate the SYNC frame for guide offsets. No video or case data is uploaded. A session-storage recovery copy is separate from financial persistence; reloading marks it interrupted rather than resuming its clock.

Steps optionally accept `edit: {shot: "screen" | "presenter" | "hold", reason: "..."}`. This is script-led post-production advice only. It never adds cues, changes the live view or forces a cut. Unannotated beats are screen candidates requiring editorial review.

## Presenter controls

- RIGHT / LEFT: next / previous visual beat.
- Hold UP: temporarily return to the module top; release restores the prior scroll and emphasis.
- H: hide/show the current/next cue HUD during preview; ignored during a clean take.
- C: open controls; recorded as an interruption during a take.
- M: mark a retake without advancing the visual.
- S: finish the external-recording take log, or stop the alternative browser recorder. Stop OBS and iPhone separately.
- Escape: stop recording, exit Presenter Mode, restore the normal case.
- Controls: load, start/restart, validate, export, prepare devices, fullscreen, record, stop or exit.

Typing in setup inputs never advances the presentation. Ordinary editing/navigation controls are suppressed in the live view. Chart hover cannot erase a directed chart-point selection. The HUD and setup controls hide during capture. The emergency Stop button appears only on hover/focus and hides before stopping.

For the alternative browser recorder, prepare devices and choose fullscreen first, validate at that capture size, restart at the first cue, then Record and choose the current tab/window in the browser picker. Live validation and a completed narrative review are required by the Record button. A changed viewport or camera-reserved width requires revalidation. Platform capture permissions and the browser picker are unavoidable manual setup.

## Validation and limits

The deterministic compiler rejects changed sources/scripts, unknown/hidden targets, unsupported actions, nonexistent or wrong-state scenarios, injected fields, duplicate steps, missing/extra/reordered cues and ambiguous script anchors. Narrative checks validate source references and recorded scalar facts. They do **not** decide whether arbitrary prose is true: Codex's source-grounded review remains a separate recorded judgement.

Live validation traverses every beat forwards and backwards using the production controller, checks resolution/visibility, waits for real component and chart animations, checks directed chart values against catalogue values and records evidence. Human visual inspection complements these checks. Whole long modules retain normal scrolling; FRAME is a coherent view of the existing module, not a promise that every paragraph fits on one screen.

V1 intentionally excludes a click-to-author editor, arbitrary financial inputs, custom calculations, automatic scenario propagation between reports, automatic language-model calls, and smart face tracking. Multi-lane SVG timeline events and calculator/composite chart points are not exposed as focusable subtargets; their existing whole visual can be framed. House-purchase local what-if overrides are not named storyboard states. Identical modules need distinct titles to be disambiguated. Any source/title/card-order change conservatively invalidates the package and requires discovery again.

Native capture availability varies by browser/OS. The browser regression uses Chrome; physical devices and system permission dialogs need a short local recording check.

## Regression checks

```sh
node scripts/check-presenter-package.mjs
node scripts/check-video-capture.mjs
node scripts/check-presenter-take.mjs
node scripts/serve-presenter.mjs 8788
# In another terminal; uses locally installed playwright-core and Chrome:
node scripts/check-presenter-browser.mjs
node scripts/check-presenter-browser.mjs --loading-only
node scripts/check-presenter-browser.mjs --recording-only
node scripts/check-presenter-browser.mjs --capture-only
node scripts/check-presenter-browser.mjs --design-only
node scripts/check-presenter-browser.mjs private/aam-makeovers/my-presentation --motion --screenshots
```

Browser fixtures remain private and do not contain client data. The generic browser check covers writable-session autosave isolation and restoration, scenario focus, disclosure reset, timeline age ranges, chart points, forward/back navigation, keyboard controls and both target sizes. Native-capture tests use a real encoder with generated canvas and oscillator tracks, never the user's devices.
