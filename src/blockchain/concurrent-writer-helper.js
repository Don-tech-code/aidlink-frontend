/**
 * Standalone concurrent-writer helper for the persistence integration test.
 *
 * This is a plain JavaScript file (not TypeScript) so it can be executed
 * directly by child_process.fork without ts-node.  It requires better-sqlite3
 * via the project's node_modules directory, which is passed as argv[5].
 *
 * Invocation (from repository.persistence.test.ts):
 *   fork(
 *     '<this file>',
 *     [dbPath, workerPrefix, rowCount, nodeModulesDir]
 *   )
 *
 * The script:
 *   1. Opens a better-sqlite3 connection to dbPath.
 *   2. Sets busy_timeout so concurrent transactions retry instead of failing.
 *   3. Inserts rowCount rows with primary keys <workerPrefix>-tx-<i>.
 *   4. Sends { done: true, inserted: N } to the parent process via IPC.
 */

/* eslint-disable */
'use strict';

const dbPath = process.argv[2];
const workerPrefix = process.argv[3];
const rowCount = parseInt(process.argv[4], 10);
const nodeModulesDir = process.argv[5];

if (!dbPath || !workerPrefix || isNaN(rowCount) || !nodeModulesDir) {
  console.error('[concurrent-writer-helper] Missing arguments');
  console.error('  argv:', process.argv.slice(2));
  process.exit(1);
}

// Require better-sqlite3 from the project's node_modules (absolute path)
const Database = require(nodeModulesDir + '/better-sqlite3');
const { randomUUID } = require('crypto');

const db = new Database(dbPath);

// WAL mode must already be set on the DB file; setting it again is a no-op
// if WAL is already active and safe to call multiple times.
db.pragma('journal_mode=WAL');
db.pragma('synchronous=NORMAL');

// busy_timeout: if another writer holds the write lock, retry for up to 30 s
// instead of immediately throwing SQLITE_BUSY.  This is the key to concurrent
// safety without advisory locks on top of WAL.
db.pragma('busy_timeout=30000');

const stmt = db.prepare(
  'INSERT OR IGNORE INTO blockchain_transactions ' +
  '(id, tx_hash, block_number, block_hash, status, "from", "to", ' +
  ' amount, fee, operation_type, created_at, indexed_at, processed) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
);

const now = new Date().toISOString();

// Wrap in a single transaction for throughput.
// SQLite WAL serialises concurrent transactions — only one writer at a time,
// but readers never block and the writer retries via busy_timeout.
const insertMany = db.transaction(function(n) {
  for (let i = 0; i < n; i++) {
    stmt.run(
      randomUUID(),
      workerPrefix + '-tx-' + i,
      i,
      '',
      'CONFIRMED',
      '',
      '',
      '0',
      '0',
      'payment',
      now,
      now,
      0
    );
  }
});

insertMany(rowCount);

const result = db.prepare(
  'SELECT COUNT(*) as n FROM blockchain_transactions WHERE tx_hash LIKE ?'
).get(workerPrefix + '-%');

db.close();

if (process.send) {
  process.send({ done: true, inserted: result.n, prefix: workerPrefix });
}

process.exit(0);
