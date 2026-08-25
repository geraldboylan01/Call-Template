#!/usr/bin/env node

/**
 * THE HARNESS DATABASE, AND THE THREE CONVERSIONS IT USED TO GET FOR FREE.
 *
 * WHAT THIS PINS. The harness D1 used to reach SQLite by spawning a Python
 * interpreter per SQL statement. That is not a correctness bug, it is a speed
 * one, and it cost more than it looks: `check:consumer-live-confirmation` spent
 * 3,898 spawns and ~133 of its ~165 seconds booting Python, which is long
 * enough to cross a default two-minute command timeout partway through. A check
 * killed between two of its cases is indistinguishable from a hung one, and
 * this one was filed as a hang twice.
 *
 * WHY A TEST AND NOT JUST A COMMENT. Going back is a one-line temptation, and
 * nothing else in the suite would notice — every assertion would still pass,
 * only slower. So the throughput floor is asserted directly: the budget here is
 * one no process-per-statement implementation can meet and no in-process one
 * can miss.
 *
 * AND THE PARITY THE SWITCH DID NOT GIVE AWAY. The old shim reached SQLite
 * through JSON, and that round trip quietly performed three conversions
 * node:sqlite does not. Each is restored by hand in `transports.mjs`, so each
 * is pinned here — a silent regression in any of them would rewrite what
 * harness databases contain rather than fail anything outright:
 *
 *   - integers bind as INTEGER, not REAL. Unfixed, a `7` written to a
 *     TEXT-affinity column becomes `'7.0'`;
 *   - a missing row is `null`, not `undefined`;
 *   - rows are ordinary objects, not null-prototype ones.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { makeEnv, newDatabase } from './agent-harness/transports.mjs';

const pass = (message) => console.info(`[AgentHarnessSqlite] PASS: ${message}`);

const database = makeEnv(newDatabase('harness-sqlite')).CONSUMER_DB;

await database.prepare(
  'CREATE TABLE probe(id INTEGER PRIMARY KEY, label TEXT NOT NULL, tx TEXT, loose)'
).run();
await database.prepare(
  'CREATE TABLE probe_child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES probe(id))'
).run();

/* ============================================== the migrated schema is real */

{
  // newDatabase() replays every migration through one multi-statement script,
  // including the trigger bodies in 0015 — so this failing means multi-statement
  // execution broke, not that a migration did.
  const table = await database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'consumer_planner_reconciliations'"
  ).first();
  assert.equal(table?.name, 'consumer_planner_reconciliations',
    'a new harness database must have replayed every migration');
  pass('multi-statement migration scripts still execute as one unit');
}

/* ============================================ 1: integers bind as INTEGER */

{
  await database.prepare('INSERT INTO probe(id, label, tx, loose) VALUES(?, ?, ?, ?)')
    .bind(1, 'ints', 7, 7).run();
  const row = await database.prepare(
    'SELECT typeof(tx) AS tx_type, tx, typeof(loose) AS loose_type, loose FROM probe WHERE id = ?'
  ).bind(1).first();
  assert.equal(row.tx, '7',
    'an integer bound into a TEXT-affinity column must store "7", not "7.0"');
  assert.equal(row.tx_type, 'text', 'and it must still be stored as text');
  assert.equal(row.loose_type, 'integer',
    'an integer bound into an affinity-free column must stay an INTEGER');
  assert.equal(row.loose, 7, 'and read back as the same number');
  pass('integers bind as INTEGER, so TEXT-affinity columns keep "7" not "7.0"');
}

{
  await database.prepare('INSERT INTO probe(id, label, tx, loose) VALUES(?, ?, ?, ?)')
    .bind(2, 'floats', 1.5, 1.5).run();
  const row = await database.prepare(
    'SELECT typeof(loose) AS loose_type, loose, tx FROM probe WHERE id = ?'
  ).bind(2).first();
  assert.equal(row.loose_type, 'real', 'a genuine float must still bind as REAL');
  assert.equal(row.loose, 1.5, 'and keep its value');
  assert.equal(row.tx, '1.5', 'and text-affinity storage must be unchanged for floats');
  pass('floats are untouched — only integral numbers are re-typed');
}

/* ================================== 2: booleans and undefined, as JSON did */

{
  await database.prepare('INSERT INTO probe(id, label, tx, loose) VALUES(?, ?, ?, ?)')
    .bind(3, 'bools', true, false).run();
  const row = await database.prepare(
    'SELECT typeof(tx) AS tx_type, tx, loose FROM probe WHERE id = ?'
  ).bind(3).first();
  assert.equal(row.loose, 0, 'false must bind as 0, the way Python bound a bool');
  assert.equal(row.tx, '1', 'and true as 1');
  assert.equal(row.tx_type, 'text', 'through the same affinity rules as any integer');

  await database.prepare('INSERT INTO probe(id, label, tx, loose) VALUES(?, ?, ?, ?)')
    .bind(4, 'undef', undefined, null).run();
  const missing = await database.prepare('SELECT tx, loose FROM probe WHERE id = ?').bind(4).first();
  assert.equal(missing.tx, null, 'undefined must bind as NULL, the way JSON.stringify made it null');
  assert.equal(missing.loose, null, 'and null must stay null');
  pass('booleans bind as 0/1 and undefined binds as NULL');
}

/* ================================= 3: a miss is null, and rows are ordinary */

{
  const miss = await database.prepare('SELECT id FROM probe WHERE id = ?').bind(999).first();
  assert.equal(miss, null, 'a missing row must be null, not undefined');
  assert.notEqual(miss, undefined, 'callers compare it against null strictly');

  const row = await database.prepare('SELECT id FROM probe WHERE id = ?').bind(1).first();
  assert.equal(Object.getPrototypeOf(row), Object.prototype,
    'rows must be ordinary objects, not the null-prototype ones node:sqlite returns');
  assert.deepEqual({ ...row }, { id: 1 }, 'and must spread and compare like plain objects');

  const empty = await database.prepare('SELECT id FROM probe WHERE id = ?').bind(999).all();
  assert.deepEqual(empty.results, [], 'an empty all() must return an empty results array');
  pass('a missing row is null and every row is an ordinary object');
}

/* ============================================== 4: affected-row accounting */

{
  const updated = await database.prepare('UPDATE probe SET label = ? WHERE id IN (1, 2)')
    .bind('touched').run();
  assert.equal(updated.meta.changes, 2, 'an UPDATE must report the rows it changed');
  const none = await database.prepare('UPDATE probe SET label = ? WHERE id = ?')
    .bind('nobody', 999).run();
  assert.equal(none.meta.changes, 0, 'an UPDATE matching nothing must report zero');
  const selected = await database.prepare('SELECT id FROM probe').run();
  assert.equal(selected.meta.changes, 0,
    'a SELECT run through run() must report zero, as Python\'s rowcount of -1 clamped to');
  pass('affected-row counts match, including the SELECT-through-run() case');
}

/* ================================================= 5: batch stays atomic */

{
  const results = await database.batch([
    { sql: 'INSERT INTO probe(id, label) VALUES(?, ?)', values: [10, 'batch-a'] },
    { sql: 'INSERT INTO probe(id, label) VALUES(?, ?)', values: [11, 'batch-b'] }
  ]);
  assert.deepEqual(results, [{ meta: { changes: 1 } }, { meta: { changes: 1 } }],
    'a batch must report per-statement change counts');

  await assert.rejects(
    database.batch([
      { sql: 'INSERT INTO probe(id, label) VALUES(?, ?)', values: [12, 'doomed'] },
      { sql: 'INSERT INTO probe(id, label) VALUES(?, ?)', values: [13, null] }
    ]),
    /NOT NULL constraint failed/,
    'a batch whose statement violates a constraint must reject'
  );
  const survivor = await database.prepare('SELECT id FROM probe WHERE id = ?').bind(12).first();
  assert.equal(survivor, null,
    'and BEGIN IMMEDIATE must have rolled the whole batch back, not just the failing statement');
  pass('batch is still one atomic transaction, and still rolls back on failure');
}

/* ============================================ 6: foreign keys still enforced */

{
  await assert.rejects(
    database.prepare('INSERT INTO probe_child(id, parent_id) VALUES(?, ?)').bind(1, 4242).run(),
    /FOREIGN KEY constraint failed/,
    'PRAGMA foreign_keys must still be applied to every connection'
  );
  pass('foreign keys are enforced on every statement, as they were per Python connection');
}

/* ================================ 7: no process-per-statement, ever again */

{
  // Comments are stripped first: the file explains at length what it no longer
  // does, and a guard that cannot tell an explanation from a call would force
  // that explanation to be deleted to stay green.
  const executable = readFileSync(
    new URL('./agent-harness/transports.mjs', import.meta.url), 'utf8'
  ).replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  for (const forbidden of ['spawnSync', 'execFileSync', 'execSync', 'child_process', 'python3']) {
    assert.equal(executable.includes(forbidden), false,
      `the harness D1 must not reach SQLite through a child process (found ${forbidden})`);
  }

  // The behavioural half of the same guard, because the source check alone is
  // satisfiable by moving the spawn one file away. 400 statements cost about a
  // fifth of a second in process; spawning an interpreter for each could not
  // finish them in under eight.
  const budgetMs = 6_000;
  const startedAt = Date.now();
  for (let index = 0; index < 400; index += 1) {
    await database.prepare('INSERT INTO probe(label) VALUES(?)').bind(`row-${index}`).run();
  }
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < budgetMs,
    `400 statements took ${elapsedMs}ms, over the ${budgetMs}ms budget — `
    + 'the harness D1 is spawning a process per statement again');
  pass(`400 statements in ${elapsedMs}ms, well inside the ${budgetMs}ms process-spawn floor`);
}

console.info('\n[AgentHarnessSqlite] PASS: the harness database is in-process and byte-compatible with what the Python shim wrote');
