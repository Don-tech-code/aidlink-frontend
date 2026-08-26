/**
 * SQLite-backed repository for the Soroban ledger indexer.
 *
 * Replaces the previous in-memory Map implementation with durable SQLite
 * storage via better-sqlite3.  The public API surface is identical to the
 * original: all callers (SorobanIndexer, API routes, tests) compile without
 * modification.
 *
 * Key design decisions:
 *   - better-sqlite3 is synchronous, which preserves the repository's
 *     synchronous call surface — no async/await changes needed in callers.
 *   - BlockchainTransaction uses tx_hash as its primary key (globally unique
 *     on the Stellar network).  Upsert is implemented as INSERT OR IGNORE +
 *     conditional UPDATE so the original id and createdAt are always
 *     preserved on conflict.
 *   - ContractEvent uses a composite PRIMARY KEY
 *     (tx_hash, contract_address, event_name, ledger_sequence, event_index)
 *     and INSERT OR IGNORE semantics — duplicate events silently no-op.
 *   - RollupTracker rows are keyed by `type` with INSERT OR REPLACE to
 *     always reflect the latest cursor state.
 *   - WAL mode and test-isolation logic live in db.ts; this module only
 *     consumes the getDb() factory.
 *   - All writes are synchronous (no I/O deferral), consistent with the
 *     original design contract.
 */

import { randomUUID } from 'crypto';
import type {
  BlockchainTransaction,
  ContractEvent,
  RollupTracker,
} from './types';
import { TransactionStatus } from './types';
import { getDb, __resetDb } from './db';

// ---------------------------------------------------------------------------
// Composite key helpers (unchanged — exported for callers that use them)
// ---------------------------------------------------------------------------

/**
 * Stable, unique composite key for a ContractEvent.
 * Matches the SQLite composite PRIMARY KEY:
 *   (tx_hash, contract_address, event_name, ledger_sequence, event_index)
 *
 * Exported for tests and callers that need the key string directly.
 */
export function eventCompositeKey(
  txHash: string,
  contractAddress: string,
  eventName: string,
  ledgerSequence: number,
  eventIndex: number
): string {
  return `${txHash}::${contractAddress}::${eventName}::${ledgerSequence}::${eventIndex}`;
}

// ---------------------------------------------------------------------------
// Row-to-domain mappers
// ---------------------------------------------------------------------------

interface TxRow {
  id: string;
  tx_hash: string;
  block_number: number;
  block_hash: string;
  status: string;
  from: string;
  to: string;
  amount: string;
  fee: string;
  operation_type: string;
  memo: string | null;
  created_at: string;
  indexed_at: string;
  processed: number;
}

interface EventRow {
  id: string;
  tx_hash: string;
  contract_address: string;
  event_name: string;
  ledger_sequence: number;
  event_index: number;
  parameters: string;
  created_at: string;
  processed: number;
}

interface TrackerRow {
  type: string;
  last_processed_ledger: number;
  last_event_cursor: string;
  updated_at: string;
}

function rowToTx(row: TxRow): BlockchainTransaction {
  return {
    id: row.id,
    txHash: row.tx_hash,
    blockNumber: row.block_number,
    blockHash: row.block_hash,
    status: row.status as TransactionStatus,
    from: row.from,
    to: row.to,
    amount: row.amount,
    fee: row.fee,
    operationType: row.operation_type,
    memo: row.memo ?? undefined,
    createdAt: row.created_at,
    indexedAt: row.indexed_at,
    processed: row.processed !== 0,
  };
}

function rowToEvent(row: EventRow): ContractEvent {
  let parameters: Record<string, unknown> = {};
  try {
    parameters = JSON.parse(row.parameters) as Record<string, unknown>;
  } catch {
    // Malformed JSON stored — return empty object rather than crashing.
  }
  return {
    id: row.id,
    txHash: row.tx_hash,
    contractAddress: row.contract_address,
    eventName: row.event_name,
    ledgerSequence: row.ledger_sequence,
    eventIndex: row.event_index,
    parameters,
    createdAt: row.created_at,
    processed: row.processed !== 0,
  };
}

function rowToTracker(row: TrackerRow): RollupTracker {
  return {
    type: row.type,
    lastProcessedLedger: row.last_processed_ledger,
    lastEventCursor: row.last_event_cursor,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// BlockchainTransaction repository
// ---------------------------------------------------------------------------

export const blockchainTransactionRepo = {
  /**
   * Insert or update a transaction row.
   * If the row already exists (by txHash) the provided `data` is merged with
   * the existing record: id and createdAt are always preserved from the first
   * insert; all other fields are updated to the new values.
   */
  upsert(data: Omit<BlockchainTransaction, 'id' | 'indexedAt'> & { id?: string }): BlockchainTransaction {
    const db = getDb();
    const now = new Date().toISOString();

    // Step 1: INSERT OR IGNORE — only inserts when the row does not exist yet.
    // This preserves the original id and createdAt on subsequent calls.
    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO blockchain_transactions
        (id, tx_hash, block_number, block_hash, status, "from", "to",
         amount, fee, operation_type, memo, created_at, indexed_at, processed)
      VALUES
        (@id, @tx_hash, @block_number, @block_hash, @status, @from, @to,
         @amount, @fee, @operation_type, @memo, @created_at, @indexed_at, @processed)
    `);

    // Step 2: UPDATE — runs unconditionally; updates mutable fields.
    // The id and createdAt columns are intentionally NOT updated here.
    const updateStmt = db.prepare(`
      UPDATE blockchain_transactions SET
        block_number   = @block_number,
        block_hash     = @block_hash,
        status         = @status,
        "from"         = @from,
        "to"           = @to,
        amount         = @amount,
        fee            = @fee,
        operation_type = @operation_type,
        memo           = @memo,
        indexed_at     = @indexed_at,
        processed      = @processed
      WHERE tx_hash = @tx_hash
    `);

    const params = {
      id: data.id ?? randomUUID(),
      tx_hash: data.txHash,
      block_number: data.blockNumber,
      block_hash: data.blockHash,
      status: data.status,
      from: data.from,
      to: data.to,
      amount: data.amount,
      fee: data.fee,
      operation_type: data.operationType,
      memo: data.memo ?? null,
      created_at: data.createdAt,
      indexed_at: now,
      processed: data.processed ? 1 : 0,
    };

    // Run both in a transaction for atomicity.
    const txn = db.transaction(() => {
      insertStmt.run(params);
      updateStmt.run(params);
    });
    txn();

    const row = db
      .prepare('SELECT * FROM blockchain_transactions WHERE tx_hash = ?')
      .get(data.txHash) as TxRow;

    return rowToTx(row);
  },

  /** Find a single transaction by its hash */
  findByHash(txHash: string): BlockchainTransaction | undefined {
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM blockchain_transactions WHERE tx_hash = ?')
      .get(txHash) as TxRow | undefined;
    return row ? rowToTx(row) : undefined;
  },

  /** Find all transactions for a given ledger sequence */
  findByLedger(ledgerSequence: number): BlockchainTransaction[] {
    const db = getDb();
    const rows = db
      .prepare('SELECT * FROM blockchain_transactions WHERE block_number = ?')
      .all(ledgerSequence) as TxRow[];
    return rows.map(rowToTx);
  },

  /**
   * Returns the row with the highest blockNumber — used to derive the
   * resume point after a restart.
   */
  findFirstByBlockNumberDesc(): BlockchainTransaction | undefined {
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM blockchain_transactions ORDER BY block_number DESC LIMIT 1')
      .get() as TxRow | undefined;
    return row ? rowToTx(row) : undefined;
  },

  /**
   * Mark every transaction in a ledger as ORPHANED.
   * Called when reorg detection finds that the ledger hash we stored does
   * not match the current canonical hash on-chain.
   */
  orphanByLedger(ledgerSequence: number): void {
    const db = getDb();
    db.prepare(`
      UPDATE blockchain_transactions
      SET status = ?, indexed_at = ?
      WHERE block_number = ?
    `).run(TransactionStatus.ORPHANED, new Date().toISOString(), ledgerSequence);
  },

  /**
   * Update the status of a single transaction by txHash.
   * No-op if the hash is not found.
   */
  updateStatus(txHash: string, status: TransactionStatus): void {
    const db = getDb();
    db.prepare(`
      UPDATE blockchain_transactions
      SET status = ?, indexed_at = ?
      WHERE tx_hash = ?
    `).run(status, new Date().toISOString(), txHash);
  },

  /** Total row count (used in tests / diagnostics) */
  count(): number {
    const db = getDb();
    const result = db
      .prepare('SELECT COUNT(*) as n FROM blockchain_transactions')
      .get() as { n: number };
    return result.n;
  },

  /** Test-only: clear all rows */
  __clear(): void {
    const db = getDb();
    db.prepare('DELETE FROM blockchain_transactions').run();
  },

  /** Test-only: dump all rows */
  __all(): BlockchainTransaction[] {
    const db = getDb();
    const rows = db
      .prepare('SELECT * FROM blockchain_transactions')
      .all() as TxRow[];
    return rows.map(rowToTx);
  },
};

// ---------------------------------------------------------------------------
// ContractEvent repository
// ---------------------------------------------------------------------------

export const contractEventRepo = {
  /**
   * Insert-or-ignore a contract event using the composite deduplication key.
   * Equivalent to:
   *   INSERT OR IGNORE INTO contract_events (...) VALUES (...)
   *
   * Returns the stored row (existing or newly created).
   */
  upsert(
    data: Omit<ContractEvent, 'id' | 'createdAt'> & { id?: string }
  ): ContractEvent {
    const db = getDb();

    const stmt = db.prepare(`
      INSERT OR IGNORE INTO contract_events
        (id, tx_hash, contract_address, event_name, ledger_sequence,
         event_index, parameters, created_at, processed)
      VALUES
        (@id, @tx_hash, @contract_address, @event_name, @ledger_sequence,
         @event_index, @parameters, @created_at, @processed)
    `);

    stmt.run({
      id: data.id ?? randomUUID(),
      tx_hash: data.txHash,
      contract_address: data.contractAddress,
      event_name: data.eventName,
      ledger_sequence: data.ledgerSequence,
      event_index: data.eventIndex,
      parameters: JSON.stringify(data.parameters),
      created_at: new Date().toISOString(),
      processed: data.processed ? 1 : 0,
    });

    // Always return the stored row (existing or new).
    const row = db.prepare(`
      SELECT * FROM contract_events
      WHERE tx_hash = ? AND contract_address = ? AND event_name = ?
        AND ledger_sequence = ? AND event_index = ?
    `).get(
      data.txHash, data.contractAddress, data.eventName,
      data.ledgerSequence, data.eventIndex
    ) as EventRow;

    return rowToEvent(row);
  },

  /** True if this exact (txHash, contractAddress, eventName, seq, index) already exists */
  exists(
    txHash: string,
    contractAddress: string,
    eventName: string,
    ledgerSequence: number,
    eventIndex: number
  ): boolean {
    const db = getDb();
    const row = db.prepare(`
      SELECT 1 FROM contract_events
      WHERE tx_hash = ? AND contract_address = ? AND event_name = ?
        AND ledger_sequence = ? AND event_index = ?
    `).get(txHash, contractAddress, eventName, ledgerSequence, eventIndex);
    return row !== undefined;
  },

  /** Count events matching a txHash and optional eventIndex */
  countByTxHash(txHash: string, eventIndex?: number): number {
    const db = getDb();
    if (eventIndex === undefined) {
      const result = db
        .prepare('SELECT COUNT(*) as n FROM contract_events WHERE tx_hash = ?')
        .get(txHash) as { n: number };
      return result.n;
    }
    const result = db
      .prepare('SELECT COUNT(*) as n FROM contract_events WHERE tx_hash = ? AND event_index = ?')
      .get(txHash, eventIndex) as { n: number };
    return result.n;
  },

  /**
   * Find a stored ContractEvent by its txHash.
   * Returns the first matching row, or undefined if none found.
   */
  findByHash(txHash: string): ContractEvent | undefined {
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM contract_events WHERE tx_hash = ? LIMIT 1')
      .get(txHash) as EventRow | undefined;
    return row ? rowToEvent(row) : undefined;
  },

  /**
   * Find all ContractEvents that have an unresolved sentinel txHash
   * (i.e. `txHash.startsWith('unresolved:')`).
   */
  findBySentinel(): ContractEvent[] {
    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM contract_events WHERE tx_hash LIKE 'unresolved:%'")
      .all() as EventRow[];
    return rows.map(rowToEvent);
  },

  /**
   * Replace a sentinel txHash with the resolved real hash.
   *
   * - If the old sentinel row does not exist, returns undefined.
   * - If the new real-hash row already exists, removes the sentinel and
   *   returns the existing real-hash row (real-hash row wins).
   * - Otherwise deletes the sentinel row and inserts a new row with the
   *   resolved hash, preserving all other fields.
   */
  updateTxHash(
    sentinelTxHash: string,
    contractAddress: string,
    eventName: string,
    ledgerSequence: number,
    eventIndex: number,
    resolvedTxHash: string
  ): ContractEvent | undefined {
    const db = getDb();

    return db.transaction((): ContractEvent | undefined => {
      // Fetch the existing sentinel row.
      const existing = db.prepare(`
        SELECT * FROM contract_events
        WHERE tx_hash = ? AND contract_address = ? AND event_name = ?
          AND ledger_sequence = ? AND event_index = ?
      `).get(
        sentinelTxHash, contractAddress, eventName, ledgerSequence, eventIndex
      ) as EventRow | undefined;

      if (!existing) return undefined;

      // Remove the sentinel row regardless of what happens next.
      db.prepare(`
        DELETE FROM contract_events
        WHERE tx_hash = ? AND contract_address = ? AND event_name = ?
          AND ledger_sequence = ? AND event_index = ?
      `).run(sentinelTxHash, contractAddress, eventName, ledgerSequence, eventIndex);

      // Check whether the real-hash row already exists.
      const winner = db.prepare(`
        SELECT * FROM contract_events
        WHERE tx_hash = ? AND contract_address = ? AND event_name = ?
          AND ledger_sequence = ? AND event_index = ?
      `).get(
        resolvedTxHash, contractAddress, eventName, ledgerSequence, eventIndex
      ) as EventRow | undefined;

      if (winner) {
        // Real-hash row already present — return it without inserting a duplicate.
        return rowToEvent(winner);
      }

      // Insert a new row with the resolved hash, preserving id, parameters,
      // createdAt, and processed from the original sentinel row.
      db.prepare(`
        INSERT INTO contract_events
          (id, tx_hash, contract_address, event_name, ledger_sequence,
           event_index, parameters, created_at, processed)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        existing.id,
        resolvedTxHash,
        existing.contract_address,
        existing.event_name,
        existing.ledger_sequence,
        existing.event_index,
        existing.parameters,
        existing.created_at,
        existing.processed,
      );

      const updated = db.prepare(`
        SELECT * FROM contract_events
        WHERE tx_hash = ? AND contract_address = ? AND event_name = ?
          AND ledger_sequence = ? AND event_index = ?
      `).get(
        resolvedTxHash, contractAddress, eventName, ledgerSequence, eventIndex
      ) as EventRow;

      return rowToEvent(updated);
    })();
  },

  /** All unprocessed events (consumed by downstream pipelines) */
  findUnprocessed(): ContractEvent[] {
    const db = getDb();
    const rows = db
      .prepare('SELECT * FROM contract_events WHERE processed = 0')
      .all() as EventRow[];
    return rows.map(rowToEvent);
  },

  /** Total row count */
  count(): number {
    const db = getDb();
    const result = db
      .prepare('SELECT COUNT(*) as n FROM contract_events')
      .get() as { n: number };
    return result.n;
  },

  /** Test-only: clear all rows */
  __clear(): void {
    const db = getDb();
    db.prepare('DELETE FROM contract_events').run();
  },

  /** Test-only: dump all rows */
  __all(): ContractEvent[] {
    const db = getDb();
    const rows = db
      .prepare('SELECT * FROM contract_events')
      .all() as EventRow[];
    return rows.map(rowToEvent);
  },
};

// ---------------------------------------------------------------------------
// RollupTracker repository (durable cursor)
// ---------------------------------------------------------------------------

export const rollupTrackerRepo = {
  /**
   * Upsert a cursor row.  Both `lastProcessedLedger` and `lastEventCursor`
   * default to 0 / '' on first creation so callers can always read a
   * valid tracker even before any progress is made.
   *
   * Partial updates are supported: supplying only `lastProcessedLedger` will
   * preserve the existing `lastEventCursor`, and vice versa.
   */
  upsert(
    type: string,
    data: Partial<Pick<RollupTracker, 'lastProcessedLedger' | 'lastEventCursor'>>
  ): RollupTracker {
    const db = getDb();
    const now = new Date().toISOString();

    // Fetch the current row so we can preserve fields that were not supplied.
    const existing = db
      .prepare('SELECT * FROM rollup_trackers WHERE type = ?')
      .get(type) as TrackerRow | undefined;

    const lastProcessedLedger =
      data.lastProcessedLedger ?? existing?.last_processed_ledger ?? 0;
    const lastEventCursor =
      data.lastEventCursor ?? existing?.last_event_cursor ?? '';

    db.prepare(`
      INSERT INTO rollup_trackers (type, last_processed_ledger, last_event_cursor, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(type) DO UPDATE SET
        last_processed_ledger = excluded.last_processed_ledger,
        last_event_cursor     = excluded.last_event_cursor,
        updated_at            = excluded.updated_at
    `).run(type, lastProcessedLedger, lastEventCursor, now);

    return {
      type,
      lastProcessedLedger,
      lastEventCursor,
      updatedAt: now,
    };
  },

  /** Find a tracker by type; returns undefined if not yet created */
  find(type: string): RollupTracker | undefined {
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM rollup_trackers WHERE type = ?')
      .get(type) as TrackerRow | undefined;
    return row ? rowToTracker(row) : undefined;
  },

  /** Find or create a tracker with zero-value defaults */
  findOrCreate(type: string): RollupTracker {
    return this.upsert(type, {});
  },

  /** Test-only: clear all rows */
  __clear(): void {
    const db = getDb();
    db.prepare('DELETE FROM rollup_trackers').run();
  },
};

// ---------------------------------------------------------------------------
// Convenience: clear all stores (used in test beforeEach)
// ---------------------------------------------------------------------------
export function __clearAllStores(): void {
  __resetDb();
}
