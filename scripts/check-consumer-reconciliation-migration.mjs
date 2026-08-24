#!/usr/bin/env node

/**
 * MIGRATION 0017, TESTED THE WAY 0008 SHOULD HAVE BEEN.
 *
 * `consumer_planner_reconciliations` is rebuilt to widen a CHECK constraint
 * and to add the occurrence-outcome counters. Migration 0008's own header
 * records what a careless rebuild costs here: it "failed against remote D1
 * while passing on empty local replicas", because an empty table exercises
 * neither the row copy nor foreign-key enforcement.
 *
 * So this check refuses to run on an empty table. It seeds a representative
 * database — every legacy trigger value, every status, real parent rows so the
 * outbound foreign keys are genuinely enforced — snapshots it, applies the
 * rebuild, and compares before and after field by field.
 *
 * WHAT IT PROVES:
 *   1. every historical trigger value still satisfies the widened constraint
 *   2. no row is lost, duplicated, reordered into the wrong record, or altered
 *   3. identifiers, timestamps, revisions, encrypted payloads and hashes are
 *      byte-identical afterwards
 *   4. the new counters default to zero rather than to invented history
 *   5. constraints and indexes survive, and the new vocabulary is accepted
 *   6. foreign keys still hold, with parent rows present
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let checks = 0;
const check = (label, condition, detail = '') => {
  checks += 1;
  assert.ok(condition, `${label}${detail ? ` — ${detail}` : ''}`);
};

const migration = (name) => readFileSync(
  new URL(`../worker/consumer-migrations/${name}.sql`, import.meta.url),
  'utf8'
);

/** Every trigger the schema accepted BEFORE 0017, so the copy is exercised. */
const LEGACY_TRIGGERS = [
  'material_turn', 'rejected_note', 'answered_need', 'redundant_question',
  'periodic_checkpoint', 'readiness_transition', 'pre_confirmation',
  'agent_shadow_replay'
];
const STATUSES = ['pending', 'shadow', 'applied', 'rejected', 'conflicted', 'failed'];

/* ------------------------------------------------------------------ set-up */

// Built from 0001-0016 ONLY, so 0017 is genuinely applied here rather than
// already present. The shared harness helper applies every migration including
// this one, which would make the test assert nothing.
const workspace = mkdtempSync(join(tmpdir(), 'reconciliation-migration-'));
process.once('exit', () => rmSync(workspace, { recursive: true, force: true }));
const database = new DatabaseSync(join(workspace, 'schema.sqlite'));
database.exec('PRAGMA foreign_keys = ON;');

// Every migration up to but NOT including the one under test, read from disk
// so the list cannot drift out of step with the directory.
const MIGRATION_NAMES = readdirSync(new URL('../worker/consumer-migrations', import.meta.url))
  .filter((name) => name.endsWith('.sql'))
  .map((name) => name.replace(/\.sql$/, ''))
  .sort()
  .filter((name) => name < '0017');
for (const name of MIGRATION_NAMES) database.exec(migration(name));

// Parent rows, so the outbound foreign keys are real rather than vacuous —
// the exact condition migration 0008 failed on remotely while passing locally.
// Required columns are read from the schema rather than hard-coded, so an
// earlier migration adding a NOT NULL column cannot silently skip this set-up.
const now = '2026-08-22T11:31:12.279Z';
function seedRow(table, overrides) {
  const columns = database.prepare(
    'SELECT name, type FROM pragma_table_info(?) WHERE "notnull" = 1 AND dflt_value IS NULL'
  ).all(table);
  const names = [...new Set([...columns.map((column) => column.name), ...Object.keys(overrides)])];
  const values = names.map((name) => {
    if (Object.hasOwn(overrides, name)) return overrides[name];
    const type = columns.find((column) => column.name === name)?.type || 'TEXT';
    if (/INT|REAL|NUM/i.test(type)) return 1;
    return /_at$/.test(name) ? now : `${name}_fixture`;
  });
  database.prepare(
    `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`
  ).run(...values);
}

seedRow('consumer_sessions', {
  id: 'sess_migration_fixture',
  status: 'active',
  created_at: now,
  last_active_at: now,
  expires_at: '2030-01-01T00:00:00.000Z'
});
seedRow('consumer_realtime_sessions', {
  id: 'lease_migration_fixture',
  session_id: 'sess_migration_fixture',
  provider: 'openai',
  status: 'complete',
  reservation_eur_micros: 1000,
  dispatch_stop_eur_micros: 900,
  starting_profile_revision: 1,
  latest_profile_revision: 9,
  hard_expires_at: '2030-01-01T00:00:00.000Z',
  idle_expires_at: '2030-01-01T00:00:00.000Z',
  created_at: now,
  last_active_at: now
});

// One row per (trigger, status) pair: 48 rows, every legacy value represented,
// with the production shape (19 rows over 4 meetings) comfortably inside it.
const insert = database.prepare(`
  INSERT INTO consumer_planner_reconciliations (
    id, session_id, realtime_session_id, reconciliation_revision,
    base_profile_revision, through_turn_id, trigger, mode, status,
    idempotency_key_hash_b64u, input_encrypted, input_hash_b64u,
    output_encrypted, output_hash_b64u, applied_profile_revision, model,
    prompt_version, input_tokens, output_tokens, cached_input_tokens,
    latency_ms, operation_count, accepted_operation_count,
    rejected_operation_count, error_code, created_at, completed_at
  ) VALUES (?, 'sess_migration_fixture', 'lease_migration_fixture', ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
let revision = 0;
for (const trigger of LEGACY_TRIGGERS) {
  for (const status of STATUSES) {
    revision += 1;
    insert.run(
      `planner_reconciliation_${revision}`, revision, revision, `turn_${revision}`,
      trigger, revision % 2 === 0 ? 'apply' : 'shadow', status,
      `idem_${revision}`, `enc_input_${revision}`, `hash_input_${revision}`,
      status === 'pending' ? null : `enc_output_${revision}`,
      status === 'pending' ? null : `hash_output_${revision}`,
      status === 'applied' ? revision + 1 : null,
      'gpt-5.6-luna', 'planning-reconciliation-v2',
      revision * 10, revision * 3, revision, revision * 100,
      revision % 5, revision % 4, revision % 3,
      status === 'failed' ? 'planner_reconciliation_failed' : null,
      `2026-08-22T11:${String(revision % 60).padStart(2, '0')}:12.279Z`,
      status === 'pending' ? null : `2026-08-22T12:${String(revision % 60).padStart(2, '0')}:12.279Z`
    );
  }
}

const ALL_COLUMNS = `id, session_id, realtime_session_id, reconciliation_revision,
  base_profile_revision, through_turn_id, trigger, mode, status,
  idempotency_key_hash_b64u, input_encrypted, input_hash_b64u,
  output_encrypted, output_hash_b64u, applied_profile_revision, model,
  prompt_version, input_tokens, output_tokens, cached_input_tokens,
  latency_ms, operation_count, accepted_operation_count,
  rejected_operation_count, error_code, created_at, completed_at`;

const snapshot = () => database
  .prepare(`SELECT ${ALL_COLUMNS} FROM consumer_planner_reconciliations ORDER BY id`)
  .all();
const indexesOf = (table) => database
  .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all(table).map((row) => row.name);

// The live production distribution, read from the deployed database on
// 2026-08-24 before this migration was proposed: 19 rows across 4 meetings,
// 2026-08-22 to 2026-08-23, all pre-pilot test traffic. Recorded so the
// fixture below is provably a superset of what the rebuild will actually meet.
const PRODUCTION_DISTRIBUTION = Object.freeze([
  ['material_turn', 'applied', 3], ['rejected_note', 'applied', 3],
  ['answered_need', 'applied', 2], ['material_turn', 'failed', 2],
  ['readiness_transition', 'failed', 2], ['answered_need', 'failed', 1],
  ['material_turn', 'shadow', 1], ['periodic_checkpoint', 'applied', 1],
  ['periodic_checkpoint', 'failed', 1], ['periodic_checkpoint', 'shadow', 1],
  ['readiness_transition', 'applied', 1], ['rejected_note', 'failed', 1]
]);

const before = snapshot();
const indexesBefore = indexesOf('consumer_planner_reconciliations');
check('the fixture is not an empty table — an empty rebuild proves nothing',
  before.length === LEGACY_TRIGGERS.length * STATUSES.length, String(before.length));
check('every trigger the old schema allowed is represented',
  new Set(before.map((row) => row.trigger)).size === LEGACY_TRIGGERS.length);
check('every status is represented',
  new Set(before.map((row) => row.status)).size === STATUSES.length);
const seeded = new Set(before.map((row) => `${row.trigger}/${row.status}`));
check('the fixture covers every trigger/status pair production actually holds',
  PRODUCTION_DISTRIBUTION.every(([trigger, status]) => seeded.has(`${trigger}/${status}`)),
  PRODUCTION_DISTRIBUTION.filter(([t, s]) => !seeded.has(`${t}/${s}`)).join(' '));
check('production rows are a strict subset of what is rebuilt here',
  PRODUCTION_DISTRIBUTION.reduce((total, [, , n]) => total + n, 0) <= before.length);

/* --------------------------------------------------------------- the rebuild */

database.exec(migration('0017_widen_reconciliation_trigger'));

const after = snapshot();
const indexesAfter = indexesOf('consumer_planner_reconciliations');

/* ------------------------------------------------------------ 1. row identity */

check('row count is unchanged', after.length === before.length,
  `${before.length} -> ${after.length}`);
check('primary identifiers are unchanged and unique',
  new Set(after.map((row) => row.id)).size === after.length
    && before.every((row, index) => after[index].id === row.id));

/* ---------------------------------------------- 2. every field, byte for byte */

const differences = [];
before.forEach((row, index) => {
  for (const [column, value] of Object.entries(row)) {
    const actual = after[index][column];
    if (actual !== value) differences.push(`${row.id}.${column}: ${value} -> ${actual}`);
  }
});
check('every copied column is identical for every row', differences.length === 0,
  differences.slice(0, 5).join('; '));

// Named explicitly, because these are the ones an audit depends on and a
// positional copy would corrupt silently.
for (const column of [
  'trigger', 'status', 'mode', 'created_at', 'completed_at',
  'reconciliation_revision', 'base_profile_revision', 'applied_profile_revision',
  'through_turn_id', 'idempotency_key_hash_b64u',
  'input_encrypted', 'input_hash_b64u', 'output_encrypted', 'output_hash_b64u',
  'operation_count', 'accepted_operation_count', 'rejected_operation_count',
  'input_tokens', 'output_tokens', 'cached_input_tokens', 'latency_ms', 'error_code'
]) {
  check(`${column} survives the rebuild for every row`,
    before.every((row, index) => after[index][column] === row[column]));
}

/* ------------------------------------------- 3. no history is invented */

const counters = database.prepare(`
  SELECT covered_value_count, uncovered_value_count, recovered_value_count,
         clarified_value_count, not_current_fact_count, unresolved_value_count,
         deferred_value_count
  FROM consumer_planner_reconciliations
`).all();
check('every new counter is zero on historical rows, not a fabricated figure',
  counters.every((row) => Object.values(row).every((value) => value === 0)));

/* ------------------------------- 4. constraints and the widened vocabulary */

check('indexes survive the rebuild',
  indexesBefore.every((name) => indexesAfter.includes(name)),
  `${indexesBefore} -> ${indexesAfter}`);
check('the analysis index for coverage-driven checkpoints exists',
  indexesAfter.includes('idx_consumer_planner_reconciliations_value_outcomes'));

let probeRevision = 900;
const insertWith = (id, trigger, extra = {}) => {
  probeRevision += 1;
  const columns = [
    'id', 'session_id', 'realtime_session_id', 'reconciliation_revision',
    'base_profile_revision', 'through_turn_id', 'trigger', 'mode', 'status',
    'idempotency_key_hash_b64u', 'input_encrypted', 'input_hash_b64u',
    'prompt_version', 'created_at', ...(extra.column ? [extra.column] : [])
  ];
  const values = [
    id, 'sess_migration_fixture', 'lease_migration_fixture', probeRevision,
    1, 'turn_probe', trigger, 'apply', 'pending',
    `idem_${id}`, 'enc', 'hash', 'planning-reconciliation-v2', now,
    ...(extra.column ? [extra.value] : [])
  ];
  return database.prepare(
    `INSERT INTO consumer_planner_reconciliations (${columns.join(', ')})
     VALUES (${columns.map(() => '?').join(', ')})`
  ).run(...values);
};

for (const trigger of ['value_coverage_gap', 'material_backlog']) {
  insertWith(`planner_reconciliation_${trigger}`, trigger);
  check(`the widened vocabulary accepts ${trigger}`,
    database.prepare('SELECT COUNT(*) AS n FROM consumer_planner_reconciliations WHERE trigger = ?')
      .get(trigger).n === 1);
}
assert.throws(() => insertWith('planner_reconciliation_bogus', 'a_trigger_nobody_migrated'),
  /CHECK constraint failed/,
  'the constraint must still refuse a trigger the schema does not know');
check('an unknown trigger is still refused after widening', true);
assert.throws(() => insertWith('planner_reconciliation_negative', 'material_turn',
  { column: 'uncovered_value_count', value: -1 }),
/CHECK constraint failed/, 'a negative counter must be refused');
check('the counters refuse a negative value', true);

/* -------------------------------------------------- 5. referential integrity */

check('foreign keys still hold after the rebuild',
  database.prepare('PRAGMA foreign_key_check').all().length === 0);
assert.throws(() => database.exec(`
  INSERT INTO consumer_planner_reconciliations (
    id, session_id, realtime_session_id, reconciliation_revision,
    base_profile_revision, through_turn_id, trigger, mode, status,
    idempotency_key_hash_b64u, input_encrypted, input_hash_b64u,
    prompt_version, created_at
  ) VALUES ('planner_reconciliation_orphan', 'sess_missing', 'lease_migration_fixture',
    999, 1, 'turn_orphan', 'material_turn', 'apply', 'pending', 'idem_orphan',
    'enc', 'hash', 'planning-reconciliation-v2', '${now}');
`), /FOREIGN KEY constraint failed/, 'the rebuilt table must still enforce its parents');
check('the rebuilt table still refuses an orphan row', true);

check('the staging table is gone',
  database.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'consumer_planner_reconciliations_new'")
    .get().n === 0);

/* ------------------------------------------------ 6. the migration is D1-safe */

const source = migration('0017_widen_reconciliation_trigger');
check('the rebuild uses the D1-supported deferral, not foreign_keys = OFF',
  /PRAGMA defer_foreign_keys = true;/.test(source) && !/PRAGMA foreign_keys/.test(source),
  'D1 ignores foreign_keys = OFF — see migration 0008');
check('the copy names its columns on both sides',
  /INSERT INTO consumer_planner_reconciliations_new \(/.test(source),
  'a positional copy shifts every value when a column is added mid-table');

database.close();
console.info(`[ReconciliationMigration] ${checks} checks passed: `
  + `${before.length} seeded rows rebuilt with no loss, no drift and no invented history.`);
