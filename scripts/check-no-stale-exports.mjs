/**
 * Nothing exported may go unreferenced without someone deciding it should.
 *
 * WHY THIS EXISTS. The expensive failures in this repository have all been the
 * same shape: a value or a code path that stopped being the truth and stayed
 * anyway. A module allowlist written out in six places and updated in two. A
 * realtime envelope pinned at 40/24 after the config moved to 100/60. A budget
 * payload that computed limit, spent and remaining and returned none of them. A
 * warning threshold that is configured, deployed, verified live -- and never
 * read. Each was invisible until a deploy failed or a client saw a wrong page.
 *
 * A file-level check cannot find every kind of stale code, but it catches the
 * commonest and cheapest kind: something exported that nothing imports. That is
 * usually either a superseded version left beside its replacement, or half of a
 * refactor that was never finished.
 *
 * THIS IS A RATCHET, NOT A CLEAN SWEEP. There are already unreferenced exports
 * here. Deleting them all in one pass would be a large, risky change unrelated
 * to whatever is being worked on, so they are listed in the baseline instead --
 * visible and counted rather than silently accepted. The check fails when the
 * list GROWS, and fails when it is out of date, so the number can only go down.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const BASELINE_PATH = `${root}scripts/stale-exports-baseline.json`;

/** Directories whose exports are checked. */
const SOURCE_DIRS = ['worker/src', 'js', 'scripts'];
/**
 * Where a reference may live. Deliberately code only: a name appearing in a
 * document or a data file does not make the code behind it live, and counting
 * those would let documentation keep dead code alive -- which is the failure
 * this check exists to find, not to reproduce.
 *
 * The baseline itself is excluded below for the same reason: it lists these
 * names, so counting it would make every listed export look referenced and the
 * check would pass forever.
 */
const REFERENCE_EXTENSIONS = ['.js', '.mjs', '.html'];

/**
 * Exported names that are entry points rather than internal API: nothing in
 * this repository imports them, and nothing should.
 */
const ENTRY_POINTS = new Set([
  'default'
]);

function walk(directory, onFile) {
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) walk(path, onFile);
    else onFile(path);
  }
}

function collect() {
  const sources = new Map();
  const references = new Map();
  for (const directory of SOURCE_DIRS) {
    walk(`${root}${directory}`, (path) => {
      const relative = path.slice(root.length);
      if (path === BASELINE_PATH) return;
      if (!REFERENCE_EXTENSIONS.some((extension) => path.endsWith(extension))) return;
      const text = readFileSync(path, 'utf8');
      references.set(relative, text);
      if (path.endsWith('.js') || path.endsWith('.mjs')) sources.set(relative, text);
    });
  }
  // A reference may also live outside the source directories -- an HTML page
  // loading a module, or documentation naming a function.
  for (const directory of ['app', 'plan', 'docs']) {
    try {
      walk(`${root}${directory}`, (path) => {
        if (!REFERENCE_EXTENSIONS.some((extension) => path.endsWith(extension))) return;
        references.set(path.slice(root.length), readFileSync(path, 'utf8'));
      });
    } catch (_error) { /* the directory need not exist */ }
  }
  return { sources, references };
}

function exportedNames(text) {
  const names = [];
  for (const pattern of [
    /^export (?:async )?function (\w+)/gm,
    /^export const (\w+)/gm,
    /^export class (\w+)/gm,
    /^export let (\w+)/gm
  ]) {
    for (const match of text.matchAll(pattern)) names.push(match[1]);
  }
  return names;
}

export function findStaleExports() {
  const { sources, references } = collect();
  const stale = [];
  for (const [file, text] of sources) {
    for (const name of exportedNames(text)) {
      if (ENTRY_POINTS.has(name)) continue;
      const used = [...references].some(([other, body]) => (
        other !== file && new RegExp(`\\b${name}\\b`).test(body)
      ));
      if (!used) stale.push(`${file}:${name}`);
    }
  }
  return stale.sort();
}

/* ------------------------------------------------------------- the ratchet */

const stale = findStaleExports();
let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
} catch (_error) {
  baseline = { note: '', entries: [] };
}
const known = new Set(baseline.entries || []);

if (process.env.UPDATE_STALE_BASELINE === 'true') {
  writeFileSync(BASELINE_PATH, `${JSON.stringify({ ...baseline, entries: stale }, null, 2)}\n`);
  console.info(`[StaleExports] baseline rewritten with ${stale.length} entries.`);
  process.exit(0);
}

const added = stale.filter((entry) => !known.has(entry));
const removed = [...known].filter((entry) => !stale.includes(entry)).sort();

assert.deepEqual(
  added,
  [],
  'These exports are referenced nowhere. Either use them, delete them, or -- if they are '
    + 'deliberately unused -- add them to scripts/stale-exports-baseline.json with a reason:\n  '
    + `${added.join('\n  ')}`
);

// The list may only shrink. A fixed entry that stays listed makes the count
// meaningless, which is how a baseline becomes another piece of stale state.
assert.deepEqual(
  removed,
  [],
  'These baseline entries are no longer stale. Run UPDATE_STALE_BASELINE=true node '
    + './scripts/check-no-stale-exports.mjs to record the improvement:\n  '
    + `${removed.join('\n  ')}`
);

console.info(`[StaleExports] ${stale.length} known unreferenced exports, none new. `
  + 'The list may only shrink.');
