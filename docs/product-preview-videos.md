# Homepage module previews

The homepage shows the real mortgage and personal balance sheet renderers with
fictional figures. Mortgage plays once when visible, then holds its final result.
Personal balance sheet is selected explicitly. Pause/resume, replay and an inline
enlarged view are available; the form CTA stays before the preview on mobile and
is also available in the enlarged view. Reduced-motion users see still images
until they explicitly play a clip.

The mortgage example compares the current repayment path, a €20,000 immediate
lump sum and €3,000 annual overpayments. It holds the rate at 4.25% and keeps the
contractual monthly repayment unchanged. All figures come from the mortgage engine.

The balance-sheet example sells a €300,000 rental property, repays its €120,000
loan and adds €180,000 to cash. The second alternative uses €100,000 of that cash
to reduce the home mortgage. Sale costs and taxes are explicitly excluded.
All three positions are passed through the balance-sheet engine; net worth stays
€735,000 in each position. Movement metadata describes transfers, not calculations.

`dev/product-preview-fixtures.js` contains the figures. `dev/product-preview.html`
uses the real module views, framed for filming with `dev/product-preview.css`.
Those development files are not copied to the deployed website.

To regenerate, set `FFMPEG_PATH` to a full FFmpeg installation with H.264 and VP9
encoders, then run `npm run generate:product-previews`. Chrome and playwright-core
are also required. `--layout-only` checks framing; `--module=balance-sheet` or
`--module=mortgage` re-exports only that module. A virtual browser clock and a
fixed 30 fps frame sequence keep cursor movements, native number transitions and
CSS movements deterministic. The filming view displays whole-euro transition
values and makes the moving amounts easier to read; the financial engines and
normal client views are unchanged.

Final MP4/WebM files and still posters live in `assets/examples/`. Desktop clips
are 1440 × 1080; mobile clips are 720 × 1290. Mortgage lasts 14 seconds and personal
balance sheet 18 seconds. MP4 is the primary source, with WebM as a fallback.
The export manifest records each file size. `npm run check:product-previews` checks
real browser decoding and the complete preview interaction. Review frames and
browser screenshots are saved under `.worker-dry-run/product-previews/`.

The videos are stored locally with the website; no embedded third-party player,
analytics provider or live AI request is used to show them.
