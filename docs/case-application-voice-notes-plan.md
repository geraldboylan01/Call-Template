# Optional voice notes for case videos

Design agreed 29 September 2026. See [implementation and activation](application-voice-notes.md). Production preparation verified approximately 7.5 MB of existing R2 payload storage and disabled public access on the dedicated audio bucket; this feature reserves at most 1 GB. Account-wide request billing is not capped by this storage quota.

Extend the current application and client pipeline. Let applicants record or attach a short voice note about their goals and worries, and let Gerry listen and download it beside the written case. Store the audio in a dedicated private Cloudflare R2 bucket in the existing account, with its metadata and permission record linked to the existing application in D1.

This fits the current OBS, iPhone and DaVinci Resolve workflow: download the note as a WAV, place the chosen excerpt on the editing timeline, then respond to it in the presentation. The submitted audio remains a separate original that can be trimmed and balanced against Gerry's microphone.

## What the applicant sees

Keep the topic-driven financial questions. They already cover household circumstances, income, spending, savings, mortgages, pensions, loans, retirement targets and related details. Add two short optional written prompts beside the main question: “What would a good outcome look like?” and “What worries you most?” These give Gerry the narrative even when someone skips audio.

Continue to allow estimates and “not sure”. Before submission, highlight important unanswered inputs for the selected topic as a helpful checklist. For example, a mortgage comparison needs the balance, rate, remaining term, repayment and amount available for overpayments. Submission is not proof that a case is ready for analysis; the advisor should see what still needs clarification before preparing a call or video. Do not replace calculator inputs with guesses from a voice note.

Add this card after the questions and before the final submission controls:

> **Tell Gerry in your own words · Optional**
>
> Adding a clear voice note greatly improves your chances of being chosen for a video review. It helps Gerry understand what matters to you and, with your permission, lets viewers hear the question in your own words. Written-only applications are still considered, and selection is not guaranteed.
>
> In 30–90 seconds, tell Gerry:
>
> - What are you hoping to achieve?
> - What worries you most?
> - What would you most like this review to answer?
>
> Speak naturally. You do not need to read out all your figures. Please leave out your full name, address, employer, account details and other people's names.

The selection wording expresses Gerry's editorial preference, not a measured increase or a promised outcome. Prioritise relevant, understandable cases; studio-quality sound is not a selection requirement.

Controls: **Record a voice note**, **Upload an audio file**, **Play**, **Record again**, and **Remove**. Recommend 30–90 seconds; cap recordings at two minutes and files at 10 MiB. Display the duration and upload status. Stop microphone tracks after recording, removal or leaving the page. Offer file upload when microphone permission is refused or recording is unsupported. No applicant account is needed.

The browser keeps the clip locally until Send. Unlike the existing text draft, an in-memory recording will not survive a reload; say this clearly and offer Save recording on this device. Do not put audio in localStorage or silently upload it while someone is recording.

## Permission to use the real voice

Use a separate, unchecked checkbox:

> I agree that Gerry may edit and play this voice note in a case review published on YouTube and planeir.ie. I understand that people may recognise my voice, even if my name is not shown.

Store the exact permission-text version, acceptance time and specific recording identity. Attaching a recording is not permission to publish it. Sending any recording requires this checkbox, enforced both in the browser and by the upload API. An unchecked box prevents submission of the recording; removing the recording allows a written-only application. Replacing it requires a fresh checkbox choice. The written application works with neither a recording nor voice-publication permission. Explain how to withdraw permission through the existing contact address.

The existing privacy notice says the applicant's own words are left out of published material. Update that statement, the collection/storage/retention descriptions, and any anonymity promises before launch. Say that names are removed but an approved real voice can be recognisable. Do not suggest that a pseudonym or ordinary pitch adjustment guarantees anonymity. Keep consent specific; social clips or other publication channels would need to be named if they are added.

This approach follows the DPC's guidance on clear, specific, informed consent and withdrawal. It is a proposed product flow, not a legal compliance determination. [DPC guidance](https://www.dataprotection.ie/en/dpc-guidance/case-studies/transparency/sharing-personal-data-third-parties-without-consent).

## Gerry's workflow

Within the existing Application section, show a **Voice note** card with duration, date, publication permission, Play, Download original, Download WAV and Delete voice note. Show a voice-note indicator in the application list and allow filtering for recordings approved for publication. Keep the final case-selection decision manual.

Use filenames such as `application-123-voice-note.wav`, matching the existing numbered case Markdown exports. Preserve the compressed original in storage. Generate an editing copy locally in the advisor's browser when Download WAV is clicked, with a conversion failure falling back to the original download. Validate the supported inputs against the actual editing workflow before launch.

Keep the normal email notification's link to the application. Do not attach the audio or expose a public download URL in an email. Gerry should retrieve the current recording and permission status from the signed-in application record.

For the first version, place the approved excerpt in Resolve, then cut to Gerry's answer and existing presenter visuals. Merely playing it in another browser tab does not prove OBS has recorded it: the current setup deliberately captures the external microphone. If live playback during a take is wanted later, add an explicit OBS media source or route the clip into the browser recorder's audio mix and verify the saved recording. Do not rely on the microphone picking up laptop speakers.

## Storage, upload and recovery

Reuse the existing Cloudflare Worker, D1 application IDs and advisor authentication. Add a dedicated `APPLICATION_AUDIO_BUCKET` binding with public access disabled. A separate bucket makes its retention and access policy independent of published-session assets; it does not provide a separate free allowance. R2 buckets are private by default, but deployed settings must be verified. [Cloudflare access documentation](https://developers.cloudflare.com/r2/buckets/public-buckets/).

Keep audio out of the existing JSON payload, database blobs, public case exports, Git and Pages builds. The current application endpoint has a 64 KiB JSON limit. A separate bounded binary upload endpoint preserves that contract.

1. Save the written application through `/api/applications`. Add a submission idempotency key so retries after a lost response do not create duplicate applications or emails.
2. If a note is requested, return a short-lived upload capability tied to that application. Store only its hash. It grants bounded upload/status access for that application, not access to other records or permission to publish. Do not use a lead number alone as authorisation.
3. Upload the clip through the Worker. Enforce actual streamed byte limits, an explicit supported-format allowlist, file-signature checks, per-application attempt limits and a global storage reservation before writing. Do not trust the extension, declared MIME type or Content-Length alone. Check duration in the browser; if it is also enforced on the server, use a bounded metadata parser and measure its Worker CPU cost. A byte cap must remain authoritative even when duration metadata is missing or forged.
4. Track pending, ready and deletion-pending states in D1. Use immutable object keys and make finalisation idempotent. R2 and D1 writes are not one transaction, so retries and orphan cleanup must reconcile partial failures. Replace an old note only after the new one is ready, and bind any permission to the replacement explicitly.
5. If upload fails, show “Your application is saved. Your voice note has not uploaded” with Retry and Continue without a voice note. Keep the local clip available for retry or download. Never tell the person the audio was received until finalisation succeeds.
6. Fetch audio only through an advisor-authenticated Worker route with no-store responses. Use the current CSRF protection for advisor mutations. Never put upload tokens, audio URLs or audio bytes into public exports, logs or the copied AI preparation packet.

Use browser-native recording with format feature detection rather than assuming every device produces MP3. Candidate formats include M4A/MP4 audio and WebM/Opus; accept other uploads only where validation, preview and conversion are supported. [MediaRecorder format detection](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static).

Cover all existing application channels. Assistant-prefilled `/apply/` links use the same recorder. Applications submitted through the assistant API should offer Add a voice note on the person's successful email-confirmation page. A scoped add/replace link can also go into the existing confirmation email, without adding another routine email. An assistant must not grant voice-publication permission for an absent recording.

Extend the current twelve-month expiry for unselected applications to include their audio. A delete or permission-withdrawal request must revoke access immediately and queue retryable object deletion; track deletion failures instead of reporting success while the file remains available. Review retained selected cases periodically. Remove abandoned uploads promptly, for example after 24 hours. The current Delete application action only clears the encrypted figures, retaining the lead/question: extend its audio handling and keep its erasure wording accurate.

## Keeping the additional cost at zero

R2 Standard currently includes 10 GB-month of storage, one million Class A operations and ten million Class B operations each month, with no egress charge. Its free tier does not apply to Infrequent Access storage. These are usage allowances, not an unlimited free service or a hard spending cap. [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

A two-minute note at an assumed 96 kbps is approximately 1.44 MB before container overhead; 1,000 such notes are about 1.44 GB. Actual browser bitrates and uploaded files vary. Existing account storage also consumes the allowance, so check total usage before setting a voice-note quota. Reserve space for pending uploads and stop new audio uploads before the allocated budget is reached while continuing to accept written applications.

Use Standard storage, compressed originals, expiry, bounded retries and server-enforced quotas. WAV conversion happens on Gerry's machine and the larger editing copies stay there. This design requires no paid recording widget, transcription service, AI API or automation subscription. The existing Worker, D1 and email service retain their own account-wide limits; any existing plan charges remain. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

## Implementation map and release checks

| Area | Existing integration point | Proposed change |
| --- | --- | --- |
| Application | `apply/index.html`, `js/apply.js`, `styles/apply.css` | Optional recorder/upload card, required voice-publication permission and recoverable upload |
| Written prompts | `js/case_application/schema.js` and its generated assistant documents | Goals/worries fields and relevant missing-input guidance |
| API/storage | `worker/src/index.js`, a new focused audio module, `worker/migrations/`, `worker/wrangler.toml` | Metadata, capabilities, idempotency, private bucket, bounded upload, authenticated retrieval and cleanup |
| Advisor | `app/clients.html`, `js/client_manager.js` | Status, playback, downloads, deletion and permission visibility |
| Assistant confirmation | `apply/confirm/index.html`, `js/apply_confirm.js` | Optional audio after confirmed submission |
| Privacy and preparation | `privacy/index.html`, application copy, `js/codex_video_brief.js` | Voice-specific disclosure; exclude audio and access capabilities from public/AI exports |
| Recording guide | `docs/presenter-recording.md` | Import the WAV as a separate audio clip and verify the final export |

Before enabling it, verify ordinary text-only submission; mobile Safari and Android recording/upload; denied microphone access; preview/removal/replacement; missing publication permission; size/type limits; unauthorised access; duplicate and interrupted requests; storage exhaustion; partial R2/D1 failures; deletion/expiry; and a downloaded note actually imported into the current editing workflow. Run the existing application, agent-application and generated-document checks after implementation. Provision the private bucket and migration before releasing the form, with audio behind its own availability flag.
