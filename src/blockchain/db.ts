/**
 * SQLite database singleton for the Soroban ledger indexer.
 *
 * Design decisions:
 *   - Single module-level Database instance, initialised lazily on first
 *     call to getDb().  better-sqlite3 is synchronous, which preserves the
 *     existing synchronous repository API surface.
 *   - WAL mode is enabled for file-based databases.  This allows concurrent
 *     readers while a writer is active and survives process crashes with at
 *     most one in-flight batch lost.
 *   - In tests the BLOCKCHAIN_DB_PATH environment variable is set to
 *     ':memory:' so each Jest worker gets an isolated in-process store with
 *     no on-disk artefacts.  __resetDb() drops and recreates all tables so
 *     individual tests can reset state without re-importing the module.
 *   - The .data directory is created on first use so the production path
 *     works without manual setup.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

// ---------------------------------------------------------------------------
// Database path — override via environment variable for test isolation
// ---------------------------------------------------------------------------

function resolveDbPath(): string {
  if (process.env.BLOCKCHAIN_DB_PATH) {
    return process.env.BLOCKCHAIN_DB_PATH;
  }
  // Default production path: <project root>/.data/blockchain.db
  return '.data/blockchain.db';
}

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS blockchain_transactions (
  id               TEXT    NOT NULL,
  tx_hash          TEXT    NOT NULL PRIMARY KEY,
  block_number     INTEGER NOT NULL,
  block_hash       TEXT    NOT NULL DEFAULT '',
  status           TEXT    NOT NULL,
  "from"           TEXT    NOT NULL DEFAULT '',
  "to"             TEXT    NOT NULL DEFAULT '',
  amount           TEXT    NOT NULL DEFAULT '0',
  fee              TEXT    NOT NULL DEFAULT '0',
  operation_type   TEXT    NOT NULL DEFAULT '',
  memo             TEXT,
  created_at       TEXT    NOT NULL,
  indexed_at       TEXT    NOT NULL,
  processed        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS contract_events (
  id               TEXT    NOT NULL,
  tx_hash          TEXT    NOT NULL,
  contract_address TEXT    NOT NULL,
  event_name       TEXT    NOT NULL,
  ledger_sequence  INTEGER NOT NULL,
  event_index      INTEGER NOT NULL,
  parameters       TEXT    NOT NULL DEFAULT '{}',
  created_at       TEXT    NOT NULL,
  processed        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tx_hash, contract_address, event_name, ledger_sequence, event_index)
);

CREATE TABLE IF NOT EXISTS rollup_trackers (
  type                   TEXT    NOT NULL PRIMARY KEY,
  last_processed_ledger  INTEGER NOT NULL DEFAULT 0,
  last_event_cursor      TEXT    NOT NULL DEFAULT '',
  updated_at             TEXT    NOT NULL
);
`;

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

let _db: Database.Database | null = null;

/**
 * Returns the singleton Database instance, creating and initialising it on
 * first call.
 */
export function getDb(): Database.Database {
  if (_db) return _db;

  const dbPath = resolveDbPath();
  const isMemory = dbPath === ':memory:';

  if (!isMemory) {
    // Ensure the directory exists before SQLite tries to create the file.
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
    } catch {
      // Directory already exists — ignore the error.
    }
  }

  const db = new Database(dbPath);

  // WAL mode for file-based databases.
  // For :memory: databases, SQLite uses 'memory' journal mode, which is
  // equivalent from the perspective of single-process correctness.
  if (!isMemory) {
    db.pragma('journal_mode=WAL');
    // Synchronous=NORMAL is appropriate for WAL — fsync on checkpoint only.
    db.pragma('synchronous=NORMAL');
  }

  // Enforce foreign keys and improve performance.
  db.pragma('foreign_keys=ON');

  // Create tables if they do not exist yet.
  db.exec(SCHEMA_SQL);

  _db = db;
  return _db;
}

/**
 * Test-only: drop all tables and recreate the schema on the current
 * database connection.  This gives each test a clean slate without
 * requiring a module re-import.
 *
 * For :memory: databases this is equivalent to clearing all stores.
 * For file-based databases this permanently deletes all rows — only
 * call this in a test environment.
 */
export function __resetDb(): void {
  const db = getDb();
  db.exec(`
    DROP TABLE IF EXISTS rollup_trackers;
    DROP TABLE IF EXISTS contract_events;
    DROP TABLE IF EXISTS blockchain_transactions;
  `);
  db.exec(SCHEMA_SQL);
}

/**
 * Test-only: close the current database connection and clear the singleton
 * so the next call to getDb() opens a fresh connection.
 *
 * Useful in integration tests that simulate cold-start boundaries by
 * re-importing repository modules.
 */
export function __closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
