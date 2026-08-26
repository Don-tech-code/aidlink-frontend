/**
 * In-memory repository for the Soroban ledger indexer.
 *
 * Provides the same surface that a Prisma client would expose for the three
 * tables the indexer needs, without any external database dependency.
 *
 * Key design decisions:
 *   - BlockchainTransaction uses txHash as its primary key (globally unique
 *     on the Stellar network).
 *   - ContractEvent uses a composite key
 *     `${txHash}::${contractAddress}::${eventName}::${ledgerSequence}::${eventIndex}`
 *     so that multiple events with the same txHash but different names/indices
 *     are stored as distinct rows (fixes the P2002-ignore-only-on-txHash bug).
 *   - RollupTracker is a keyed Map<type, RollupTracker>; there is at most one
 *     row per logical cursor type.
 *   - All writes are synchronous (no I/O), which is intentional: the indexer
 *     should never hold an async "DB transaction" across RPC calls.
 */

import { randomUUID } from 'crypto';
import type {
  BlockchainTransaction,
  ContractEvent,
  RollupTracker,
} from './types';
import { TransactionStatus } from './types';

// ---------------------------------------------------------------------------
// Module-level stores (survive across import calls in a single Node process,
// which is the equivalent of a persistent connection pool to a DB)
// ---------------------------------------------------------------------------

const txStore = new Map<string, BlockchainTransaction>();
const eventStore = new Map<string, ContractEvent>();
const trackerStore = new Map<string, RollupTracker>();

// ---------------------------------------------------------------------------
// Composite key helpers
// ---------------------------------------------------------------------------

/**
 * Stable, unique composite key for a ContractEvent.
 * Matches the Prisma compound unique constraint:
 *   @@unique([txHash, contractAddress, eventName, ledgerSequence, eventIndex])
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
// BlockchainTransaction repository
// ---------------------------------------------------------------------------

export const blockchainTransactionRepo = {
  /**
   * Insert or update a transaction row.
   * If the row already exists (by txHash) the provided `data` is shallowly
   * merged with the existing record.
   */
  upsert(data: Omit<BlockchainTransaction, 'id' | 'indexedAt'> & { id?: string }): BlockchainTransaction {
    const existing = txStore.get(data.txHash);
    const now = new Date().toISOString();
    const row: BlockchainTransaction = {
      id: existing?.id ?? data.id ?? randomUUID(),
      txHash: data.txHash,
      blockNumber: data.blockNumber,
      blockHash: data.blockHash,
      status: data.status,
      from: data.from,
      to: data.to,
      amount: data.amount,
      fee: data.fee,
      operationType: data.operationType,
      memo: data.memo,
      createdAt: existing?.createdAt ?? data.createdAt,
      indexedAt: now,
      processed: data.processed,
    };
    txStore.set(data.txHash, row);
    return row;
  },

  /** Find a single transaction by its hash */
  findByHash(txHash: string): BlockchainTransaction | undefined {
    return txStore.get(txHash);
  },

  /** Find all transactions for a given ledger sequence */
  findByLedger(ledgerSequence: number): BlockchainTransaction[] {
    const result: BlockchainTransaction[] = [];
    for (const tx of txStore.values()) {
      if (tx.blockNumber === ledgerSequence) result.push(tx);
    }
    return result;
  },

  /**
   * Returns the row with the highest blockNumber — used to derive the
   * resume point after a restart.
   */
  findFirstByBlockNumberDesc(): BlockchainTransaction | undefined {
    let best: BlockchainTransaction | undefined;
    for (const tx of txStore.values()) {
      if (!best || tx.blockNumber > best.blockNumber) best = tx;
    }
    return best;
  },

  /**
   * Mark every transaction in a ledger as ORPHANED.
   * Called when reorg detection finds that the ledger hash we stored does
   * not match the current canonical hash on-chain.
   */
  orphanByLedger(ledgerSequence: number): void {
    for (const [key, tx] of txStore.entries()) {
      if (tx.blockNumber === ledgerSequence) {
        txStore.set(key, {
          ...tx,
          status: TransactionStatus.ORPHANED,
          indexedAt: new Date().toISOString(),
        });
      }
    }
  },

  /**
   * Update the status of a single transaction by txHash.
   * No-op if the hash is not found.
   */
  updateStatus(txHash: string, status: TransactionStatus): void {
    const existing = txStore.get(txHash);
    if (existing) {
      txStore.set(txHash, {
        ...existing,
        status,
        indexedAt: new Date().toISOString(),
      });
    }
  },

  /** Total row count (used in tests / diagnostics) */
  count(): number {
    return txStore.size;
  },

  /** Test-only: clear all rows */
  __clear(): void {
    txStore.clear();
  },

  /** Test-only: dump all rows */
  __all(): BlockchainTransaction[] {
    return Array.from(txStore.values());
  },
};

// ---------------------------------------------------------------------------
// ContractEvent repository
// ---------------------------------------------------------------------------

export const contractEventRepo = {
  /**
   * Insert-or-ignore a contract event using the composite deduplication key.
   * Equivalent to:
   *   prisma.contractEvent.upsert({
   *     where: { txHash_contractAddress_eventName_ledgerSequence_eventIndex: ... },
   *     create: ...,
   *     update: {},   // no-op on conflict
   *   })
   *
   * Returns the stored row (existing or newly created).
   */
  upsert(
    data: Omit<ContractEvent, 'id' | 'createdAt'> & { id?: string }
  ): ContractEvent {
    const key = eventCompositeKey(
      data.txHash,
      data.contractAddress,
      data.eventName,
      data.ledgerSequence,
      data.eventIndex
    );
    const existing = eventStore.get(key);
    if (existing) return existing; // idempotent — never overwrite on conflict

    const row: ContractEvent = {
      id: data.id ?? randomUUID(),
      txHash: data.txHash,
      contractAddress: data.contractAddress,
      eventName: data.eventName,
      ledgerSequence: data.ledgerSequence,
      eventIndex: data.eventIndex,
      parameters: data.parameters,
      createdAt: new Date().toISOString(),
      processed: data.processed,
    };
    eventStore.set(key, row);
    return row;
  },

  /** True if this exact (txHash, contractAddress, eventName, seq, index) already exists */
  exists(
    txHash: string,
    contractAddress: string,
    eventName: string,
    ledgerSequence: number,
    eventIndex: number
  ): boolean {
    return eventStore.has(
      eventCompositeKey(txHash, contractAddress, eventName, ledgerSequence, eventIndex)
    );
  },

  /** Count events matching a txHash and optional eventIndex */
  countByTxHash(txHash: string, eventIndex?: number): number {
    let count = 0;
    for (const ev of eventStore.values()) {
      if (ev.txHash === txHash) {
        if (eventIndex === undefined || ev.eventIndex === eventIndex) count++;
      }
    }
    return count;
  },

  /**
   * Find a stored ContractEvent by its txHash.
   * Returns the first matching row, or undefined if none found.
   * Primarily used to verify re-resolution in tests.
   */
  findByHash(txHash: string): ContractEvent | undefined {
    for (const ev of eventStore.values()) {
      if (ev.txHash === txHash) return ev;
    }
    return undefined;
  },

  /**
   * Find all ContractEvents that have an unresolved sentinel txHash
   * (i.e. `txHash.startsWith('unresolved:')`).
   *
   * Used by the re-resolution cycle in the indexer to pick up events
   * that were stored while the Horizon fallback was unavailable.
   */
  findBySentinel(): ContractEvent[] {
    const result: ContractEvent[] = [];
    for (const ev of eventStore.values()) {
      if (ev.txHash.startsWith('unresolved:')) result.push(ev);
    }
    return result;
  },

  /**
   * Replace a sentinel txHash with the resolved real hash.
   *
   * This re-keys the event in the store:
   *   - The old composite key (built with the sentinel) is removed.
   *   - A new composite key (built with the real hash) is inserted.
   *   - If the new key already exists, the old sentinel row is dropped
   *     (the real-hash row wins — the event was already resolved elsewhere).
   *
   * Returns the updated row, or undefined if the old sentinel was not found.
   */
  updateTxHash(
    sentinelTxHash: string,
    contractAddress: string,
    eventName: string,
    ledgerSequence: number,
    eventIndex: number,
    resolvedTxHash: string
  ): ContractEvent | undefined {
    const oldKey = eventCompositeKey(
      sentinelTxHash,
      contractAddress,
      eventName,
      ledgerSequence,
      eventIndex
    );
    const existing = eventStore.get(oldKey);
    if (!existing) return undefined;

    const newKey = eventCompositeKey(
      resolvedTxHash,
      contractAddress,
      eventName,
      ledgerSequence,
      eventIndex
    );

    // Remove the old sentinel entry regardless
    eventStore.delete(oldKey);

    // If the new key already exists (e.g. parallel resolution), just return
    // the winning row without overwriting it.
    if (eventStore.has(newKey)) {
      return eventStore.get(newKey)!;
    }

    const updated: ContractEvent = { ...existing, txHash: resolvedTxHash };
    eventStore.set(newKey, updated);
    return updated;
  },

  /** All unprocessed events (consumed by downstream pipelines) */
  findUnprocessed(): ContractEvent[] {
    const result: ContractEvent[] = [];
    for (const ev of eventStore.values()) {
      if (!ev.processed) result.push(ev);
    }
    return result;
  },

  /** Total row count */
  count(): number {
    return eventStore.size;
  },

  /** Test-only: clear all rows */
  __clear(): void {
    eventStore.clear();
  },

  /** Test-only: dump all rows */
  __all(): ContractEvent[] {
    return Array.from(eventStore.values());
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
   */
  upsert(
    type: string,
    data: Partial<Pick<RollupTracker, 'lastProcessedLedger' | 'lastEventCursor'>>
  ): RollupTracker {
    const existing = trackerStore.get(type);
    const row: RollupTracker = {
      type,
      lastProcessedLedger: data.lastProcessedLedger ?? existing?.lastProcessedLedger ?? 0,
      lastEventCursor: data.lastEventCursor ?? existing?.lastEventCursor ?? '',
      updatedAt: new Date().toISOString(),
    };
    trackerStore.set(type, row);
    return row;
  },

  /** Find a tracker by type; returns undefined if not yet created */
  find(type: string): RollupTracker | undefined {
    return trackerStore.get(type);
  },

  /** Find or create a tracker with zero-value defaults */
  findOrCreate(type: string): RollupTracker {
    return this.upsert(type, {});
  },

  /** Test-only: clear all rows */
  __clear(): void {
    trackerStore.clear();
  },
};

// ---------------------------------------------------------------------------
// Convenience: clear all stores (used in test beforeEach)
// ---------------------------------------------------------------------------
export function __clearAllStores(): void {
  blockchainTransactionRepo.__clear();
  contractEventRepo.__clear();
  rollupTrackerRepo.__clear();
}
