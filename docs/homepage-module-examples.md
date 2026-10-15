# Homepage module examples

The homepage uses the same autoplaying, tabbed preview for Mortgage, Personal balance sheet, College funding, Household cash flow and Protection gap. All five use the shared `dev/product-preview.html` filming frame around the actual native module renderers. Each has a separate desktop and portrait-phone export, with a visible pointer, click rings and timed captions. The households and inputs are fictional. Only finished clips and posters are public; Presenter packages and sample sessions remain in the local recording bundle.

## College budget, revised 15 October 2026

The Future Cost Fund example uses **€15,000 total annual costs in today's money**, for a fictional Irish undergraduate living away from home over a nine-month academic year and eligible for free tuition:

| Sample allocation | Annual cost today |
| --- | ---: |
| Student contribution | €2,500 |
| Accommodation and utilities | €8,000 |
| Food, travel, books and other costs | €4,500 |
| Total | €15,000 |

These allocations are an illustrative budget, not quoted university prices. The [TU Dublin 2026/27 cost-of-living guide](https://www.tudublin.ie/for-students/student-services-and-support/financial-support/cost-of-living-guide/) was checked on 15 October 2026 for context: its annual away-from-home budget varies by accommodation and includes the student charge. Eligibility, accommodation, course, grants, tax relief and student earnings change actual costs. This sample does not deduct support or earnings.

College begins eight years from now and lasts four years. The native engine inflates each year's €15,000 base by its central 4% education inflation assumption: years 8–11, total about €87,200. The funding cases use gross cash interest of 0.2% and DIRT of 33% (net 0.134%). The resulting rounded examples are €86,100 now; €10,800 yearly for eight years; €43,000 now plus €5,400 yearly; or €17,300 yearly after waiting three years. Rounding each displayed amount separately can make apparent sums differ. Planning assumptions are not predictions of fees or returns.

The revised recording labels the native module **College: fees and living costs**. The matching script and Presenter package explain the all-in budget and assumptions. This does not change the app's general college-cost defaults or its calculation engines.

## Other examples

- Household Cash Flow: Niamh and Dara, €75,000 gross salary each, app-estimated 2026 tax, and €96,000 stated annual outgoings. Cases remove €6,000 car repayments, add €10,000 gross pension contributions, or combine both. The upfront loan payoff is outside this annual comparison.
- Protection Gap: a separate household, Maeve and Finn, with €102,000 combined take-home income, €96,000 needs and €60,000 savings. State payments and the changed costs after death are explicit inputs, not entitlement calculations. Savings duration assumes no interest or inflation.

## Playback and validation

Mortgage plays silently when the inline preview enters view. Selecting a tab switches and plays that example in the same player. Each clip plays once, with Pause/Resume/Replay and Enlarge controls, matching the original two examples. Videos pause offscreen and in background tabs. Reduced-motion preferences keep previews still until Play is pressed. Only the selected module's recording is loaded. Enlarge opens the selected clip at its current time with native seeking and fullscreen controls; Escape closes it and restores focus.

All five have 1440×1080 desktop and 720×1290 phone exports, encoded at 30 fps as silent MP4 and WebM. The three newer previews each last 18 seconds, with scenario clicks at 3.6, 7.8 and 12 seconds, matching the originals' short demonstrations. Phone captures use the native narrow layouts, including the cash-flow bar and two-column scenario controls. The shared filming CSS sizes the native views, keeps the charts and figures intact, and removes repeated headings and explanations already covered by the frame and caption. No financial calculations or charts are replaced. All five tabs remain visible and wrap on small screens. Local media URLs carry the build version.

The capture generator steps a virtual 30 fps clock and records each frame, so encoding time cannot alter the pointer travel, click rings or native 520 ms scenario transitions. It checks every scenario at both sizes for clipped text and an overflowing frame, and saves review frames around every click. Regenerate with `node scripts/create-product-preview-videos.mjs --module=future-cost-fund` (or the other module slug); `--layout-only` checks the compositions first. Chrome, local `playwright-core` and the `FFMPEG_PATH` encoder are required. `assets/examples/product-preview-manifest.json` records the actual export sizes and timings.

The local recording bundle is `private/video-calls/2026-10-14-new-module-videos/` in the primary checkout. The revised college recording passed all native Presenter cues forward and backward at 1920×1080 and 1280×720, plus full-frame capture and codec checks. Run `npm run build` and `node scripts/check-homepage-module-videos.mjs` to check the built homepage's desktop/mobile autoplay, all five module selections, keyboard navigation, pause/replay, enlargement, source loading and reduced motion. Browser checks use the same local `playwright-core` dependency and Chrome setup as the existing browser checks.
