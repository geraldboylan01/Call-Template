// Collects every figure from every catalogue into the index the engines and the
// in-app AI read (js/planning/figures/figures_index.generated.js) and the register
// people read (docs/figures-register.md).
//
// Generated, never edited by hand, like the module manifest. After changing any
// catalogue, run `npm run build:figures`. `--check` fails when either file is
// stale, which is how `check:figures` keeps them honest.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { collectFigures } from '../js/planning/figures/collect.js';
import { renderIndexSource, renderRegisterMarkdown, summariseCatalogues } from '../js/planning/figures/register_build.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const indexPath = resolve(root, 'js/planning/figures/figures_index.generated.js');
const registerPath = resolve(root, 'docs/figures-register.md');

const figures = collectFigures();
const catalogues = summariseCatalogues(figures);
const outputs = [
  [indexPath, renderIndexSource(figures, catalogues), 'npm run build:figures'],
  [registerPath, renderRegisterMarkdown(figures, catalogues), 'npm run build:figures']
];

if (process.argv.includes('--check')) {
  for (const [path, expected, fix] of outputs) {
    let current = '';
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      // A missing file is stale.
    }
    if (current !== expected) {
      console.error(`[Figures] ${path.replace(`${root}/`, '')} is stale. Run \`${fix}\`.`);
      process.exit(1);
    }
  }
  console.info(`[Figures] The index and the register match the catalogues (${figures.length} figures).`);
} else {
  for (const [path, text] of outputs) {
    writeFileSync(path, text);
    console.info(`[Figures] wrote ${path.replace(`${root}/`, '')}`);
  }
  console.info(`[Figures] ${figures.length} figures from ${catalogues.length} catalogues.`);
}
