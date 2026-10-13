# Private workspace copy release

The public site introduces the new service without opening submissions or paid
booking. The form is a browser-local preview. Its submit handler always stops
before transport, including Enter-key and programmatic submissions. Existing
case-video intake endpoints return 410 by default; earlier confirmations,
records, audio permissions and erasure remain part of their original service.

Marketing copy is written for the finished service, in the present tense. It
centres on bringing detailed financial education beyond the wealthy few through
technology and Gerry's experience with clients across every part of the advice
process. No numerical exclusivity claim or equivalence to professional advice
is made. Actual preview limits appear at the form and in the notices; writing
launch copy does not enable workspace generation, return access or deletion.

## Copy and policy sources

- `js/workspace/copy.js`: headline, founder story, FAQs, status messages and
  versioned workspace acknowledgements. There is no automatic conversion from
  video publication consent. The workspace draft has its own storage key.
- `scripts/generate-workspace-pages.mjs`: homepage, identical public privacy
  routes and workspace terms. `npm run generate:workspace-copy` regenerates
  these; `npm run check:workspace-copy` detects drift and tests closed intake.
- `apply/index.html` and `js/apply.js`: topic-based form, estimates, local draft,
  assistant-prefill review and clearing. No microphone or upload feature.
- `js/workspace/status.js`: accessible renderer for actual job events. It does
  not poll, invent percentages, advance on a timer or show results without a job.
- `js/workspace/output_copy.js`: ready-to-connect receipt/report templates and
  assumptions wording. These are not sent or used to claim that a preview
  created a workspace.
- Assistant guides and schemas describe prefill only. Their public OpenAPI
  paths remain empty until a workspace submission interface is implemented.
- The case generator keeps historical pages but no longer reinserts a video
  gallery into the homepage. Historical case pages are outside the launch path.

## Required before opening the workspace

1. Implement the form-to-engine job, its real status events, incomplete-input
   handling, retries and result delivery. Financial values must come from the
   calculation engines; AI helps identify scenarios from the user's objectives
   and organise the relevant modules. It is not described as explaining modules.
2. Implement secure persistent return access and deletion. The chosen policy is
   storage until user deletion, with no inactivity expiry. Do not remove the
   invited beta's expiry as a substitute for workspace ownership/access.
3. Finish the payment/cancellation terms for the €100, 40-minute Zoom education
   call. Call requests now use the existing consented consumer handoff and client
   pipeline, with the offer version stored in the encrypted receipt. The staff
   scheduler creates a private 40-minute Zoom invitation with accept/decline
   links. No external booking URL is needed for that workflow. No payment is
   taken when requesting a time. Calls are private and unrecorded by default; referrals are excluded.
4. Confirm the actual processor list, AI data sent, international transfer
   safeguards and the separate retention of security, email and booking records.
   Finalise the launch notice against that implementation. Do not promise zero
   provider retention, no model training or exclusive user access without proof.
5. Connect the new versioned acknowledgements to server-side records, validate
   adult eligibility, and run the full generation/return/correction/deletion and
   booking journey on desktop and mobile. Only then remove the form-preview
   notices and change the release state. The marketing wording already describes
   the finished service; it does not need a second launch rewrite. The present
   checks intentionally enforce closed submission.

## Historical services

`/privacy/legacy-applications.html` preserves the original case-video notice.
`/plan/privacy-legacy.html` preserves the invited consumer notice. The invited
consumer page and deployment configuration now point to that original notice;
its seven-day expiry and voice terms are unchanged. Existing saved receipts may
require disclosure refresh because the canonical notice URL moved.

Historical email templates still describe their own service. They must not be
rewritten to claim a workspace was created. The old form is kept only in the
development fixture `dev/legacy-application.html`, not the deployed public flow.

## Verification

`npm run check:workspace-copy`, `npm run check:workspace-browser`,
`npm run check:education-call`,
`npm run check:case-application`, `npm run check:application-voice`,
`npm run check:agent-applications`, `npm run check:consumer-voice-frontend`,
`npm run check:consumer-result-presentation`, `npm run check:consumer-entry-contract`,
`npm run check:deploy-canary-config` and `npm run build` cover this change.
Browser checks use fictional figures and capture local screenshots under
`.worker-dry-run/workspace-copy/`; they verify that no POST submission occurs.

## Call invitation placement

The homepage mentions only an optional call in its FAQ; the public form, notices,
terms and assistant guide also contain no call fee, duration or paid-call language.
Pricing appears on a
current completed analysis and the ensuing private request form. The invitation
is “Talk through your results with Gerry.” It offers discussion with the person
who built Planéir. Incomplete, stale and review-only outcomes show no invitation.

The existing Zoom account configuration is reused. New requests carry a distinct
service offer and never grant recording permission or become “free calls”. The
user shares contact details and a discussion note, not their profile or calculated
figures. Gerry can review that request in the existing client pipeline and propose
a time; the invitation email and calendar attachment use 40 minutes. Payment
collection remains a separate dependency. No live meetings or emails are created
by the test suite.
