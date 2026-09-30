# Application voice notes

The production configuration enables optional voice notes using the private `planeir-application-audio` bucket and a 1 GB quota. The release workflow applies the database migration, preserves or creates the application encryption key, and verifies the live consent and storage flow before reporting success.

## Applicant experience

The existing application now asks what a good outcome looks like and what worries the applicant most. A checklist highlights useful missing financial details without requiring guesses.

When enabled, **Tell Gerry in your own words** offers an optional microphone recording or audio-file upload. It recommends 30–90 seconds, explains the preference for voice notes when choosing reviews, and still accepts written-only applications. Applicants can listen, save a local copy, replace or remove their recording. Microphone access is released after recording.

Every recording requires this separate, initially unchecked permission:

> I agree that Gerry may edit and play this voice note in a case review published on YouTube and planeir.ie. I understand that people may recognise my voice, even if my name is not shown.

Replacing the file resets the checkbox. The form, upload preparation API and binary upload API enforce permission. D1 records the exact wording, version, acceptance time and recording digest. General application consent does not substitute for voice permission. The privacy notice describes publication, storage, recognisability and withdrawal through hello@planeir.ie.

The written application is saved first. Upload failures leave it intact and allow retry or removal of the recording. Submission identifiers prevent duplicate cases and emails after a lost response, including a reload. Text drafts remain on the device; audio stays in memory until sent, so the page offers **Save recording on this device** before leaving.

The existing receipt email includes a seven-day add/replace link. Assistant-prefilled forms use the same recorder. Assistant API applications offer recording on the person's email-confirmation page; assistants do not provide voice consent on the person's behalf.

## Finding and using a recording

1. Sign in and open **Client Pipeline**. **Has a voice note approved for video** filters the list.
2. Open the application and its **Voice note** card. Check the recorded permission and listen before choosing an excerpt.
3. Choose **Download WAV** for the editing timeline, or **Download original** to preserve the submitted file. Filenames include the application number. WAV conversion runs locally in your browser; if that browser cannot decode the original, it offers the original download instead.
4. Save the WAV beside the OBS recording, iPhone video and edit package. Import it into DaVinci Resolve, put the chosen excerpt on a separate audio track, and balance its volume against Gerry's microphone. Listen to the exported video before publication. See [the recording guide](presenter-recording.md).

Audio is not embedded in public case JSON, copied case text, AI preparation packets, emails or presenter packages. Downloads require the advisor's signed-in session; there is no public audio URL. Receipt links allow upload/status only, never playback or access to financial details.

**Delete voice note** revokes the upload link and playback access, and deletes the stored object. If storage deletion fails, the interface reports it and the hourly job retries. **Delete application** also removes its audio; as before, the pipeline's name, email and question remain. Downloaded copies, editing projects and already-published excerpts must be handled separately when permission is withdrawn.

## Storage and cost controls

This uses the existing Cloudflare Worker, D1 database, advisor login and receipt email, plus one dedicated private R2 **Standard** bucket. No recording widget, transcription, AI call or extra email subscription is required.

The release workflow groups non-secret consumer planning settings into JSON variables under 4 KiB each to fit the Workers Free limit of 64 variables, including secrets. Feature switches and planning modes stay explicit. The committed configuration remains readable, and deployment checks compare every expanded value and runtime configuration before release. Existing secrets are never packed or rotated by this step.

The default audio allocation is **1,000,000,000 bytes** across ready, reserved and deletion-pending files. The server rejects uploads before exceeding that allocation. Each file is capped at **10 MiB**, each link at ten upload reservations, and public audio mutations at 60 requests per IP per hour. There is no automatic quota increase. Written applications continue when voice capacity is exhausted.

R2 Standard's current free allowance includes 10 GB-month of storage, one million Class A operations and ten million Class B operations per month, with free egress. The allowance is shared across the account; a separate bucket does not create another allowance. Check existing usage before activation. The feature quota bounds its stored bytes, not account-wide billing, request costs or existing Worker/D1/email costs. [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/).

Browser playback validates the two-minute duration limit. The server enforces actual streamed byte count, allowed MIME types, container signatures and SHA-256 identity; it does not fully decode audio or independently prove duration. Supported formats are M4A/MP4 audio, MP3, WAV, WebM and Ogg where the browser can decode them. There is no server-side conversion or transcription.

Unselected applications and their audio expire after twelve months. Selected or published cases remain for the production workflow and should be reviewed periodically. Unfinished upload reservations expire after fifteen minutes and are cleaned by the existing hourly job. Deleted-object records remain for 24 hours so cleanup can catch a late in-flight upload; their reserved bytes are released only after that grace period and successful deletion.

## Activation

1. Check account-wide R2/Worker/D1 usage and confirm advisor authentication and the existing `APPLICATION_DATA_ENCRYPTION_KEY` are configured. Do not expose or replace the existing encryption key: it also protects stored written applications.
2. Create a dedicated **Standard** R2 bucket named `planeir-application-audio`. Leave both its public development URL and custom domains disabled. No browser-to-bucket CORS policy or public bucket access is needed.
3. Uncomment the `APPLICATION_AUDIO_BUCKET` R2 binding in `worker/wrangler.toml`. Keep `APPLICATION_AUDIO_ENABLED = "false"` for the first deployment and retain the default quota, or choose a lower allocation based on existing account usage.
4. Apply the additive `0019_add_application_voice_notes.sql` migration before releasing the updated Worker. The existing `deploy-worker.yml` workflow applies all adviser migrations before deployment. Deploy the Worker and updated Pages files, including the privacy notice.
5. Verify private access settings, then set `APPLICATION_AUDIO_ENABLED = "true"` in the committed Worker configuration and redeploy through the existing workflow. Dashboard-only edits can be overwritten by that workflow. The recorder is shown only when the configuration endpoint confirms the feature, bucket, database and encryption key are available.
6. Make a synthetic application and verify recording/upload on an actual iPhone/Safari and Android/Chrome, permission rejection, signed-in playback, WAV import in Resolve and deletion. Check Worker CPU/error metrics at the maximum supported upload size before opening intake. The automated checks below do not replace those physical-device and deployed-storage checks.

For rollback, set `APPLICATION_AUDIO_ENABLED = "false"` and redeploy. Written intake continues. Keep the bucket binding and migration: advisor playback/deletion and cleanup of existing recordings remain available. Turning uploads off does not withdraw permission or erase existing files.

For local development, use a local-only Wrangler config with the audio binding and enabled flag, local D1 migrations, and local test secrets. Do not point a test configuration at remote storage. The automated checks already provide isolated SQLite and fake object storage, so they require neither Cloudflare credentials nor real email delivery.

## Verification

Run from the repository root with Node 22.13 or newer:

```sh
npm run check:application-voice
npm run check:application-voice-browser
npm run check:case-application
npm run check:agent-applications
npm run check:agent-docs
npm run check:advisor-browser-auth
npm run check:codex-video-brief
npm run build
```

The browser check uses locally installed `playwright-core` and Chrome (`CHROME_PATH` can override the executable). It serves only local test assets, captures email, uses synthetic audio and exercises the real Worker handlers against SQLite. Screenshots are saved under the ignored `.worker-dry-run/application-voice/` directory.

Integration coverage includes strict permission on each upload path, private retrieval, CSRF, replacement, malformed/oversized uploads, quota races, uncertain writes, deletion during upload, retryable deletion, expiry and assistant confirmation. Browser coverage includes the mobile layout, native recording, permission reset, denied microphone, upload retry, response-loss recovery across reload, playback, WAV download, filtering and deletion. The release workflow also runs `scripts/check-application-voice-live.mjs` against production with its existing advisor smoke credentials. It seeds one synthetic record without submitting an application or sending email, verifies a 10 MiB upload, consent, authenticated download and deletion, and removes the test data. Physical mobile devices and Resolve import still require a check on those devices.
