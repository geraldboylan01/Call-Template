# Record Planéir and yourself, then choose the picture

Use **iPhone Camera + OBS Studio on the Mac + DaVinci Resolve Free**. Keep two continuous original recordings. Planéir controls the financial presentation and writes an edit package; OBS records the clean screen and external microphone; the iPhone records you. Start and stop both recorders yourself. Planéir cannot verify that either recorder is running.

## Open presenter view from a client's analysis

1. Open the client's analysis in the normal Planéir advisor workspace. Finish any financial edits and close comparison mode.
2. You need the case's `presentation.json` and `script.md`, generated from that case and its completed script. Give Codex the case material, module JSON and style reference; Codex discovers the live targets and prepares this package. The app does not generate the narrative automatically. A package for a different or edited case is rejected.
3. Click **Presenter Mode** in the top bar. Select `presentation.json` and `script.md` together in **Presentation package**. Click **Download presenter script** to save the annotated reading copy.
4. Click **Start preview**. The case opens before cue 1. RIGHT advances one complete visual beat; LEFT reconstructs the previous beat. No financial change is saved by Presenter Mode.
5. Open **Controls**, choose **Fullscreen** if desired, and settle on the final window size. Click **Validate live**. It rehearses every beat in both directions; wait for it to finish. Validation is required before starting a clean take and must be rerun if the capture layout changes.
6. Put the annotated script on a second display or print it. Keep the Planéir browser focused when using the arrows. The captured window must contain only Planéir, not the script or editor.

For Frasier, the local preview at `http://127.0.0.1:8788/private/aam-makeovers/2026-09-23-frasier-presenter/` already loads the case and its package. Start at step 5. Run `node scripts/serve-presenter.mjs 8788` from the repository if that preview server is not already running.

## Set up OBS once

Download [OBS Studio](https://obsproject.com/download), open it, and allow macOS screen recording and microphone access when asked. Restart OBS if macOS requests it.

Create a scene called **Planéir screen**. Add **macOS Screen Capture**, choose window capture, and select the Planéir browser window. Depending on OBS/macOS version, the source wording may vary. Disable capture of the mouse cursor. Crop browser chrome if it remains visible; do not crop the financial content. Confirm that the preview fills the canvas without stretching.

Choose an actual 16:9 capture area: 1920×1080 is a practical baseline; use 3840×2160 only when your display/capture supplies that detail. Set **Settings → Video** base and output resolutions to the chosen size and **30 fps**. Do not enlarge a smaller source to claim extra detail. Check that figures remain readable at the intended viewing size.

In **Settings → Output**, choose a high-quality recording preset and an available **H.264** encoder (Apple hardware H.264 where offered). Use **MKV** as the recording format and **AAC** audio. In **Settings → Advanced → Recording**, enable **Automatically remux to MP4**. Remuxing changes the container without re-encoding the video. Keep the original MKV until you have checked the MP4. See the [OBS recording guide](https://obsproject.com/kb/standard-recording-output-guide).

### External microphone on the Mac

1. Connect the microphone before opening the recording setup.
2. In OBS, add **Audio Input Capture** and explicitly select that microphone by name. Use this as the single voice source. Disable any duplicate global Mic/Aux source and audio from the screen-capture source if it duplicates the same sound.
3. Set OBS audio to **48 kHz**. If the mic exposes one voice channel, enable **Mono** for that source in Advanced Audio Properties so speech is centred.
4. Speak at your normal recording level. Aim for healthy movement, roughly −12 to −6 dB on louder phrases, without touching red/0 dB. Adjust mic gain and distance. Keep monitoring off unless you deliberately monitor through headphones.
5. Record a 20–30 second test, stop, and **listen to the saved file**. A moving meter alone does not verify the saved audio track or its quality. Check picture, text sharpness, framing and sound before the long take.

For the recommended OBS workflow, do not prepare the browser microphone/camera or start its alternative WebM recorder. The external microphone is selected in OBS. If recording a live conversation, this setup captures your voice only unless you also deliberately configure the call's remote audio in OBS; the iPhone reference sound is not a substitute for that remote audio track.

## Set up the iPhone

Mount it horizontally at eye level with the rear camera facing you. Use the Camera app to record locally. Choose **4K at 30 fps** if supported. For this straightforward SDR workflow, turn off **HDR Video** and **Auto FPS** in Camera recording settings. Use ordinary video mode. Keep exposure/focus stable, light your face softly, and place the script near the lens. Check power, free storage and framing before the take. Available settings vary by model: [Apple camera settings](https://support.apple.com/guide/iphone/change-video-recording-settings-iphc1827d32f/ios).

Leave iPhone audio enabled: it is the reference for synchronising with the external microphone captured by OBS. The iPhone records its own video file; do not select it as a Continuity Camera webcam for this workflow. Transfer the original recording to the Mac with AirDrop or a cable, preserving its quality.

## Record each take

1. Rehearse the script and verify the package at your final capture size. Activate macOS/iPhone Focus to avoid interruptions.
2. Start the iPhone recording. Start **Recording** in OBS. Check that the external mic meter responds.
3. With both running, say the case/take name and clap once in view of the camera. Both audio tracks should hear the clap. They do not need to have started at the same instant.
4. Return to Planéir **Controls → Record for editing · iPhone + OBS**. Tick the recorder/microphone confirmation, then click **Start clean take**.
5. Planéir restarts before cue 1, displays a three-second countdown followed by a one-second **SYNC** slate, and hides its controls, cue HUD, camera inset and cursor. The first SYNC frame is the screen reference for the exported timings. The slate is visual; there is no automatic sync beep.
6. Begin speaking when the slate disappears. Press RIGHT at each `[→ LABEL]`. One press handles all the module, scenario, animation, scroll and emphasis operations. LEFT goes back. Keep the window size fixed and the browser focused.
7. If you stumble, pause, press **M** to mark a retake and repeat the sentence. LEFT and RIGHT can repeat a visual; every visit is retained in the log. Keep both recordings running.
8. At the end, leave a few seconds of silence and clap once more to help check long-take alignment. Press **S** to finish the take log. **Stop OBS and the iPhone separately.** S does not stop those recorders.
9. Click **Download edit package**. Save its ZIP alongside the two recordings. The controls shown after S are an expendable tail to trim in the edit.

**C** opens controls during a take and logs that event for removal in the edit. **H** cannot reveal the HUD during a clean take. **Escape** ends the log and exits Presenter Mode; the external recordings still need to be stopped. Avoid resizing or changing tabs while speaking. Visibility/size changes are flagged in the log, because they may affect capture or animation.

Each ZIP contains `take.json`, `cues.csv`, `edit-guide.md`, `script-timed.md`, the source `script.md` and `presentation.json`, and the live `validation.json`. The log distinguishes when each move was requested, when the visual settled, failures, repeated beats and retakes. No video is included or uploaded. A per-tab recovery copy survives an ordinary reload when browser session storage is available; it is marked interrupted and cannot resume a continuous clock. Download before closing the tab. A new take requires downloading the previous package first.

## Edit the two views in DaVinci Resolve Free

1. Download [DaVinci Resolve Free](https://www.blackmagicdesign.com/products/davinciresolve). Create a project and set the timeline frame rate to **30 fps before editing**. Use a 1080p timeline for a 1080p screen capture, or UHD for a genuinely UHD screen capture.
2. Import the original iPhone video and the OBS **MP4** into the Media Pool. Select both, right-click and choose **Create New Multicam Clip Using Selected Clips**. Set angle synchronisation to **Sound**. Use clip names to distinguish the two angles if that option is offered.
3. Verify the sync: check the starting clap, lip movement and speech near the end. If sound sync fails, align the two clap peaks manually inside the multicam timeline. Independent devices can drift; if the end differs, correct alignment/drift before cutting. Do not assume matching “30 fps” guarantees identical clocks.
4. Put the multicam clip in your editing timeline and enable the multicam source viewer. Select the **OBS external-microphone audio** as the continuous voice track. Select **video-only** switching. Mute the iPhone reference audio; do not mix both microphones and create echo.
5. Play the take and click either the camera or screen angle to make cuts. Those choices can be changed afterwards. Begin with you, show the analysis when the viewer needs the evidence, then return to you for interpretation. Leave useful screen views on screen long enough to read. Resolve documents [waveform sync and video-only multicam switching](https://www.blackmagicdesign.com/products/davinciresolve/edit).
6. Open `edit-guide.md` beside Resolve. Find the first **SYNC** frame in the screen source and note its position from the start of that file. **Screen source position = SYNC position + logged elapsed time.** Example: SYNC occurs 12.400 seconds into the file, and a visual arrives 40.250 seconds later: inspect 52.650 seconds in that source. After trimming or moving the multicam clip, apply the appropriate timeline offset. These are browser event times, not encoded frame timecodes; verify the cut visually. The CSV is a readable log, not a one-click Resolve marker importer.
7. `script-timed.md` lists all actual visits beside each planned cue. It is not a transcript or automatic speech alignment. Use your delivery to choose the exact edit. Review failed moves, retakes and visits backwards rather than treating them as final-cut instructions.
8. Trim the countdown, slates, mistakes and controls. Keep the external-microphone audio consistent across picture cuts. Use simple cuts; the Planéir footage already contains its visual transitions and highlights.
9. Export a **H.264/AAC MP4**, at 30 fps and the timeline resolution, using a high-quality preset. Watch the exported file for sync, text readability and audio before uploading it. Keep the recordings and project for future revisions. Uploading/publishing is a separate action.

## What is and is not automated

Planéir automatically executes the visuals, hides recording distractions, records actual cue events, and builds the local edit package. Codex can add optional `edit: {shot: "screen" | "presenter" | "hold", reason: "..."}` direction to each scripted beat. These recommendations never switch cameras or add arrow cues.

You start/stop OBS and iPhone, transfer the footage, verify audio synchronisation and choose/review the final edit. Physical devices, OS permissions, OBS capture and Resolve media import require a short real recording test on your Mac. Automated browser checks use fixtures and do not prove that your microphone or iPhone is recording.
