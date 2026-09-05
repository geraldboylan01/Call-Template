# Newgrange brand implementation and rollout

## Scope and status

Implemented locally on 4 September 2026. Nothing has been deployed, pushed, or uploaded to external profiles as part of this change. Functional icons, application behavior, API contracts, and email wording are unchanged.

The six supplied SVGs in `assets/brand/` are the canonical artwork: `planeir-lockup.svg`, `planeir-lockup-light.svg`, `planeir-lockup-dark.svg`, `planeir-mark.svg`, `planeir-mark-light.svg`, and `planeir-wordmark-dotless.svg`. Their paths, upper-right opening, 1330×384 proportions, and `translate(978 38) scale(0.90625)` tittle registration are retained. `currentColor` variants are for inline use; light/dark files are self-contained image assets.

## Generated assets

Run from the repository root:

```sh
npm ci
npm run generate:brand
npm run check:brand
npm run check:success-animation
npm run build
```

`generate:brand` uses the exact development-only `@resvg/resvg-js` version in the lockfile, requires no installed fonts, and produces 29 deterministic files. Commit generated outputs with the source changes; do not hand-edit them. `check:brand` recomputes outputs without writing and checks geometry, compatibility aliases, all 12 deployed HTML entry points, nine logo placements, and retired-asset removal. The build checks both source and `dist/` and versions static imports/references. Both relevant CI workflows run the brand/animation gates.

The generated manifest, `assets/brand/planeir-brand-manifest.json`, records output dimensions, hashes, aliases, and renderer version. Fixed social/recording copy is stored as font-independent outlines; licensing and optional reauthoring instructions are in `scripts/brand/README.md`.

| Use | Files |
| --- | --- |
| Header logos | `assets/brand/planeir-lockup-light.svg`; dark version for light backgrounds |
| Raster lockups | `assets/brand/planeir-lockup-{light,dark}.png`, 1330×384 |
| Browser icons | Root `favicon.svg`, `favicon-32.png`, `favicon.ico` (16/32/48), `apple-touch-icon.png` (180) |
| Reusable app icons | `assets/brand/planeir-app-icon-{192,512}.png`; no manifest/install behavior added |
| Social and new email image | `assets/brand/planeir-social-card-newgrange.png` and editable SVG, 1200×630 |
| YouTube compositions | Three SVG/PNG pairs under `assets/brand/youtube/`, 1920×1080 |
| Zoom/profile exports | `assets/brand/zoom/planeir-wordmark-dark-square-{300,400,512,1024}.png` |
| Legacy root logo | `Planeir_logo_transparent.png`, 2000×2000, new dark artwork on transparency |

All nine header images themselves are at least 150px wide, with proportional height. Adviser controls wrap; `js/brand_header.js` measures those headers and updates the content inset. Marketing retains its existing header measurement, and planner/privacy headers stay in normal flow. The catalogue now has a scrollable content region below its measured header, so wrapping cannot strand lower controls.

### Compatibility and retirement

These existing URLs now return **new** artwork:

- `assets/brand/planeir-wordmark-light.svg` and `.png`
- `assets/brand/planeir-wordmark-dark.svg` and `.png`
- `assets/brand/planeir-social-card.png`
- Root `favicon.png`

Internal references use canonical filenames. New Open Graph/Twitter previews and all five Worker email variants use `https://planeir.ie/assets/brand/planeir-social-card-newgrange.png`. The shared email image retains its 560×294 HTML dimensions, 100% fluid width capped at 560px, and automatic height. Old harp assets, generator, animation module, and dormant ghost markup have been removed from deployment directories; historical versions remain in Git history.

## Success takeover

`createSuccessTakeover(...).play(...)` and `.reset()` remain the integration interface. The only production triggers remain:

1. A successful call-request submission.
2. Adviser publishing in email mode, after publication **and** client-email delivery succeed.

Validation failures, failed lead requests, failed publishing, failed email delivery, direct/share publishing, resend-only flows, missing client email, and page load do not trigger it. Tests exercise the real two handler functions with stubbed side effects; no real lead or email is created.

The single inline SVG is built from generated canonical path constants in `js/planeir_brand_artwork.js`. `js/success_alignment.js` owns the handoff's passage mask, gradients, bloom, emphasis, and authored frames; `js/success_takeover.js` owns one cancellable frame clock and lifecycle. SVG effect IDs are unique per controller instance.

| Authored time | Behavior |
| --- | --- |
| 0–420ms | Navy backdrop fades in |
| 80–830ms | Header copy flies to centre, 70px curved lift |
| 900ms | Passage light enters |
| 1,520ms | Ignition beat, with the prototype's surrounding glow/flash envelopes |
| 1,850–2,270ms | Existing success copy enters |
| 1,850–5,650ms | 3.8-second timer, including copy entrance |
| 5,650–6,210ms | Return to remeasured header, 38.5px curved lift |
| 6,090–6,490ms | Backdrop fades; complete cleanup at 6,490ms |

The authored clock starts after a bounded preparation period for image decoding and viewport/keyboard settling (at most 520ms while visible). Hidden-tab time does not consume animation or reading time.

Click, Escape, Close, and timer completion share an idempotent dismissal path. Early return begins at the current rendered pose. Replay settles the previous promise; navigation/reset cancels immediately. Cleanup restores header visibility, styles, background inert state, scroll locking, and appropriate focus. Both submission handlers capture focus intent before disabling their buttons. A missing return destination uses a safe fade. The returned artwork resolves to the exact static monochrome lockup before the original header is restored.

Reduced motion uses a static lit lockup and message with a 200ms entrance, the same 3.8-second timer, and a 200ms exit. It has no flight, passage beam, emphasis scaling, or flashes. No standalone 7.3-second reveal, splash, audio, or video bumper was introduced.

## Local review and verification

Serve the repository with a static server, then open:

- `/dev/success-takeover-preview.html`: both copy variants, exact-time frames, Play/Replay, cancellation, and simulated reduced motion. Inspect frame freezes the clock; Close/click/Escape resumes it for the real return path. Floating controls are preview-only.
- `/dev/brand-review.html`: the nine real page templates/styles with business scripts/forms/embedded videos disabled. Header measurements are available in the disclosure. The 200% text option is a computed-font stress test, not a substitute for device/browser accessibility testing.
- `/dev/email-brand-preview.html`: the five actual Worker HTML variants rendered with fictitious data and no API/email calls. Its image URL expects the repository to be served locally.

The `dev/` previews are excluded from the deployed artifact.

Local verification completed:

- Brand regeneration and built-artifact consistency: 29 outputs, 12 pages, nine headers.
- Success animation: 13 regression suites, including exact cleanup timing, every dismissal phase, replay, hidden tabs, missing origin, resizing, reduced motion, focus/inert/style restoration, and both real business handlers' success/excluded branches.
- In-app browser header review at 320, 390, 768, and 1440px widths, 844×390 landscape, and doubled-text stress at 320px: logo widths meet the minimum; header controls stay within the viewport.
- Browser review of unlit/lit frames, both copy variants, reduced motion, Close/Escape, replay, and final return geometry. In the desktop preview, the returned overlay and original header differed by less than 0.01px.
- Versioned-asset smoke check against the local `dist/` server, not production.
- Related video scene, video summary, video brief, adviser authentication, publishing, and stale-export checks.

Physical iOS/Android keyboard behavior, Safari/Firefox, assistive-technology announcements, and email-client-specific rendering still need release QA on their real platforms. No production lead submissions or real email sends were used for verification.

## Authorized release checklist

Deployment is a separate action requiring authorization. Existing GitHub Pages and Worker deployment mechanisms remain in place.

1. Run the checks above and review the diff, including generated files and deletions.
2. Deploy the Pages asset/application artifact together. Confirm the new social/email image URL returns the new card **before** deploying the Worker reference.
3. Run `scripts/check-pages-versioned-assets.sh` with the release `GITHUB_SHA`. It checks all twelve HTML pages, favicon declarations, nine canonical logo references, header sizing modules, and the complete versioned takeover import chain. `PLANEIR_SMOKE_ORIGIN` can override the origin for a local/staging artifact; otherwise existing CNAME/PAGE_URL behavior is retained.
4. Deploy the Worker with the updated shared email image URL; no schema or API migration is required.
5. Check live favicon loading, canonical/compatibility URLs, all five email variants, and both takeover surfaces using a controlled test fixture or explicitly approved test data. Recheck failed-email and direct-publish exclusions.
6. Complete the real-device/assistive-technology/email-client QA above and the external-upload checklist below.

If rollback is required, roll back the application/Worker references while keeping new and compatibility static URLs available, so already-sent emails do not acquire broken images.

## External-upload checklist

- [ ] Replace Zoom profile artwork with the appropriate square export. Review any separately configured Zoom virtual background.
- [ ] Replace external YouTube profile/channel artwork where applicable; repository changes do not update account settings.
- [ ] Replace locally saved recording/composer backgrounds with the new PNGs. The app's active video-composer background already references a regenerated file.
- [ ] Use normal-reading YouTube compositions for final output. Preserve their presenter-safe areas and existing copy.
- [ ] Treat `planeir-youtube-bg-mirror-edit-wordmark-bottom-right-reversed.*` as **editing-only; flip back before publication**. Check the final exported frame reads normally and the mark opens upper-right. Do not upload the reversed file as finished channel/profile artwork.
- [ ] Refresh any downloaded templates, slides, signatures, or other external copies that incorporated the former logo.
- [ ] Check social preview refresh tools/caches when publishing new links. New filenames reduce stale caching but do not invalidate every provider's cache.

Existing recorded videos are not automatically rebranded. Previously downloaded files do not change. Previously sent email HTML cannot be rewritten; compatibility URLs serve new artwork when re-fetched, but email/social/browser caches may continue showing their stored old image until refreshed by that client or service.
