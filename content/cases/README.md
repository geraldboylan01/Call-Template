# Published case videos

One JSON file per published video. `npm run generate:cases` turns these into the
gallery at `/cases/`, one page per video at `/cases/<slug>/`, the "Latest cases"
row on the homepage, and `sitemap.xml`. `npm run check:cases` fails if the
generated pages are out of date.

## Adding a case

1. In the client pipeline (`/app/clients.html`), open the application and press
   **Copy public case JSON**. The figures are already rounded, and the name, email,
   lender and the person's own words are already left out.
2. Save it here as `content/cases/<slug>.json`. The file name must match `slug`.
3. Fill in the fields left blank:
   - `youtubeId`: the 11-character id from the video link.
   - `publishedDate`: `YYYY-MM-DD`.
   - `duration`: for example `PT9M40S` (optional).
   - `summary`: one or two sentences for the card and the page description.
   - `question`: the question, written in your own words. Leave out anything that
     could identify the person.
   - `covers`: up to 8 short lines on what the video covers (optional).
4. Read `situation` once more for anything identifying, then run
   `npm run generate:cases` and commit the JSON with the generated pages.
5. Send the "video is live" email from the application in the client pipeline.

A file without a `youtubeId` is treated as a draft and skipped.

## Fields

| Field | Required | Notes |
|---|---|---|
| `slug` | yes | lowercase words joined by hyphens, same as the file name |
| `title` | yes | 140 characters at most |
| `publishedDate` | yes | `YYYY-MM-DD` |
| `youtubeId` | yes | 11 characters |
| `duration` | no | ISO 8601, like `PT9M40S` |
| `topics` | yes | any of `retirement`, `mortgage`, `buying`, `education`, `loans`, `savings`, `whole`, `other` |
| `summary` | yes | 300 characters at most |
| `situation` | yes | sections of `{ "heading", "lines" }`; a line is text, or `{ "label", "lines" }` for one pension, loan or child |
| `question` | yes | 600 characters at most |
| `covers` | no | up to 8 lines |
