/**
 * A place to stand inside someone else's await.
 *
 * WHY THIS EXISTS. The invariant under test is that newer client input
 * invalidates an older approval no matter WHERE it arrives -- and "where"
 * means one of the dozen await points between the client agreeing and the
 * financial engine starting. Picking one of them by hand tests the one the
 * auditor happened to reproduce; the next refactor moves the gap somewhere
 * else and the test goes on passing.
 *
 * So the database is the ruler. Every await between the approval barrier and
 * the engine goes through D1 at least once, so counting statements gives a
 * dense, self-calibrating set of interleaving points that needs no knowledge of
 * which function is running. The harness arms a counter when the approval
 * starts, and fires the caller's callback immediately before the Nth statement
 * after that -- synchronously, so what the callback does is what would really
 * have happened at that instant.
 *
 * NOTHING ELSE IS CHANGED. The wrapper forwards every call to the real D1 and
 * returns its real results; the statements it counts are the ones production
 * would run anyway.
 */

/**
 * Wrap a harness D1 so a callback can fire at a chosen point in its traffic.
 *
 * @param {object} database the real harness D1
 * @returns {{database: object, arm: (fireAt: number, callback: (sql: string) => void) => void,
 *            disarm: () => number, executed: () => number}}
 */
export function interleavingDatabase(database) {
  let armed = false;
  let executed = 0;
  let fireAt = 0;
  let callback = null;
  let fired = false;

  const log = [];
  const beforeStatement = async (sql) => {
    if (!armed) return;
    executed += 1;
    log.push(String(sql || ''));
    if (fired || executed !== fireAt || typeof callback !== 'function') return;
    fired = true;
    // A callback may return a promise, and it is awaited. That is the
    // difference between "another request has arrived at this instant" and
    // "another request has arrived and completely finished at this instant",
    // and both are orderings the invariant has to survive.
    const settling = callback(sql);
    if (settling && typeof settling.then === 'function') await settling;
  };

  const wrapStatement = (statement, sql) => ({
    sql,
    get values() { return statement.values; },
    bind: (...values) => wrapStatement(statement.bind(...values), sql),
    first: async () => { await beforeStatement(sql); return statement.first(); },
    all: async () => { await beforeStatement(sql); return statement.all(); },
    run: async () => { await beforeStatement(sql); return statement.run(); }
  });

  return {
    database: {
      prepare: (sql) => wrapStatement(database.prepare(sql), sql),
      // A batch is one atomic step, so it counts once and is forwarded with
      // the underlying statements' own sql and values.
      batch: async (statements) => {
        await beforeStatement('BATCH');
        return database.batch(statements.map((item) => ({ sql: item.sql, values: item.values })));
      },
      exec: database.exec ? (...args) => database.exec(...args) : undefined
    },
    /** Start counting, and fire `at` statements from now. Pass 0 to only count. */
    arm(at = 0, onFire = null) {
      armed = true;
      executed = 0;
      fired = false;
      fireAt = Number(at) || 0;
      callback = onFire;
      log.length = 0;
    },
    /** The statements seen since arming, so a test can calibrate on them. */
    statements: () => [...log],
    disarm() {
      armed = false;
      callback = null;
      return executed;
    },
    executed: () => executed,
    fired: () => fired
  };
}
