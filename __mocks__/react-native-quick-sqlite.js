/**
 * Manual Jest mock for `react-native-quick-sqlite`.
 *
 * Why: our business logic (claimPendingQueue's dedup/stale-recovery,
 * the 30-day/60-minute rate-limit windows, etc.) lives INSIDE raw SQL
 * strings. A fake JS object that just returns canned data would test
 * nothing real — a bug in the SQL itself would still pass. Instead we
 * back this mock with Node's built-in `node:sqlite` (DatabaseSync), a
 * real SQLite engine, so tests exercise the actual queries the app runs
 * on-device (op-sqlite/quick-sqlite are also SQLite under the hood, so
 * the SQL dialect matches).
 *
 * Used automatically by any test file that calls:
 *   jest.mock('react-native-quick-sqlite');
 */
const { DatabaseSync } = require('node:sqlite');

// Keyed by db name so multiple open({name}) calls with the same name
// share one in-memory database within a test file, same as the real
// module (and matches getDB()'s own module-level singleton caching).
const openDatabases = new Map();

const wrap = (nativeDb) => ({
  execute: (sql, params = []) => {
    const stmt = nativeDb.prepare(sql);
    const isSelect = /^\s*(SELECT|PRAGMA)/i.test(sql);
    if (isSelect) {
      const rows = stmt.all(...params);
      return { rows: { _array: rows, length: rows.length } };
    }
    const info = stmt.run(...params);
    return {
      rows: { _array: [], length: 0 },
      rowsAffected: info.changes,
      insertId: info.lastInsertRowid,
    };
  },
  close: () => nativeDb.close(),
});

const open = ({ name }) => {
  if (!openDatabases.has(name)) {
    openDatabases.set(name, wrap(new DatabaseSync(':memory:')));
  }
  return openDatabases.get(name);
};

// Test-only helper: lets a test start with a completely fresh database
// (e.g. between describe blocks) instead of accumulating state.
const __resetAllForTests = () => {
  openDatabases.clear();
};

module.exports = { open, __resetAllForTests };