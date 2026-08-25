# Legacy voice clients — reference only

Nothing in this directory is part of the active browser call path.

The only production call controller is `../live_voice.js`, constructed by
`../voice_lane.js`. There is intentionally no runtime lane selector.

- `controlled_realtime_voice.js` is the previous Worker-controlled realtime
  client. Keep it for historical comparison and regression archaeology. Never
  import it into the active application or apply current live-call fixes there.
- `bounded_voice_45s.js` is the removed 45-second record/transcribe/playback
  flow. It has no UI entry point and must never be restored as a fallback.

If an old test needs one of these files, label that test as legacy and import
the explicit path under `js/plan/legacy/`. A production dependency on this
directory is an architecture violation.
