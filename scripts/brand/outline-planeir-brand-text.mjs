// Optional authoring tool: ordinary brand generation needs only the committed outlines.
// Usage: node scripts/brand/outline-planeir-brand-text.mjs /path/to/pdfjs/standard_fonts
// Font files are hash-pinned below, preventing silent substitutions on another machine.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { Resvg } from '@resvg/resvg-js';

const require = createRequire(import.meta.url);
if (require('@resvg/resvg-js/package.json').version !== '2.6.2') throw new Error('Use the pinned @resvg/resvg-js@2.6.2 renderer.');
const FONT_HASHES = {
  'LiberationSans-Regular.ttf': 'f8ace1f892b2bd9dc1792ba7f097fa7588f84fed48321480e04de5390828221f',
  'LiberationSans-Bold.ttf': '361c61b82d575c5c35fd9157fda8b0194bcfcd0d88ea8521a4fb5dd53d33dddc'
};
const fontDir = process.argv[2];
if (!fontDir) throw new Error('Pass the directory containing the hash-pinned Liberation Sans font files.');
const fontFiles = [];
for (const [name, hash] of Object.entries(FONT_HASHES)) {
  const path = resolve(fontDir, name);
  const bytes = await readFile(path);
  if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error(`Unexpected font bytes: ${name}`);
  fontFiles.push(path);
}
const definitions = {
  headline: { text: 'Irish financial education', size: 72, weight: 700 },
  headlineSecond: { text: 'calls', size: 72, weight: 700 },
  description: { text: 'Experience-led live visual explanations.', size: 32, weight: 400 },
  disclaimer: { text: 'Educational only, not financial advice.', size: 25, weight: 400 },
  url: { text: 'planeir.ie', size: 25, weight: 700 }
};
const outlines = { fontFamily: 'Liberation Sans', fontHashes: FONT_HASHES, renderer: '@resvg/resvg-js@2.6.2', baseline: 80, lines: {} };
for (const [id, definition] of Object.entries(definitions)) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="120"><text x="0" y="80" font-family="Liberation Sans" font-size="${definition.size}" font-weight="${definition.weight}">${definition.text}</text></svg>`;
  const renderer = new Resvg(svg, { font: { loadSystemFonts: false, fontFiles } });
  const outlined = renderer.toString();
  if (/<text\b/.test(outlined)) throw new Error(`Text was not outlined: ${id}`);
  const paths = [...outlined.matchAll(/<path\b[^>]*\sd="([^"]+)"[^>]*\/>/g)].map((match) => match[1]);
  if (paths.length !== 1) throw new Error(`Expected one outlined path for ${id}; got ${paths.length}`);
  const bounds = renderer.getBBox();
  outlines.lines[id] = { ...definition, path: paths[0], bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } };
}
await writeFile(new URL('./planeir-text-outlines.json', import.meta.url), `${JSON.stringify(outlines, null, 2)}\n`);
console.log('Updated scripts/brand/planeir-text-outlines.json. Re-run the brand generator.');
