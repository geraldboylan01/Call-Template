# Fixed-copy font outlines

`planeir-text-outlines.json` contains vector outlines for the exact, existing
social-card copy and YouTube URL badge. These are presentation text, not logo
geometry. Logo geometry comes only from the six canonical `assets/brand` SVGs.

The text was outlined using `@resvg/resvg-js@2.6.2` from Liberation Sans Regular
and Bold, distributed in the `pdfjs-dist@5.6.205/standard_fonts` directory. Liberation
Sans is licensed under the SIL Open Font License 1.1; the unmodified accompanying
license is preserved in `LICENSE_LIBERATION`. Upstream sources:

- https://github.com/liberationfonts/liberation-fonts
- https://github.com/mozilla/pdf.js/tree/master/standard_fonts

The two exact font-file SHA-256 values are recorded in the JSON and in the
optional authoring script. No font files are shipped or read by the ordinary
brand generator. It renders these already outlined paths with system-font
loading disabled, so the exports do not change according to installed fonts.

To intentionally reauthor the fixed copy, obtain those exact font files and run:

```sh
node scripts/brand/outline-planeir-brand-text.mjs /path/to/standard_fonts
npm run generate:brand
npm run check:brand
```

The optional authoring script refuses fonts with different hashes. Existing
copy is asserted by the main generator, so a copy change must be intentional in
both scripts. Review the generated social card and YouTube background after
changing text. The outline source records original font size, weight, baseline,
and vector bounding box for each fixed line.

## Generated asset contract

`scripts/generate-planeir-brand-assets.mjs` exports `generateBrandAssets`,
`CANONICAL_ASSET_PATHS`, and `GENERATED_ASSET_PATHS` for checks. Importing the
module does not write anything. Running it writes 29 files, including a manifest
with input/output SHA-256 hashes. `--check` re-creates every buffer in memory and
compares the bytes, returning failure for missing or stale output without writes.

- `planeir-wordmark-light/dark.svg` and PNG are compatibility aliases to the new
  lockup, and the old social-card PNG is an alias to its new canonical filename.
- The mirrored-edit YouTube artwork is intentionally reversed at bottom right.
  After an editor horizontally flips the full video, it reads correctly at
  bottom left; its transform also mirrors the Newgrange alignment mark.
- Zoom assets keep the white square and 80%-width dark logo composition.
- `Planeir_logo_transparent.png` is now truly transparent, 2000 × 2000, with
  the canonical 1330 × 384 dark lockup centered.
- ICO contains PNG-compressed 16, 32, and 48 pixel frames.
- Canonical SVG inputs are never rewritten or deleted by this script.
