/**
 * Core types for the Soroban/Stellar ledger indexer.
 *
 * Design note: This project has no persistent database. All state is kept in
 * module-level in-memory Maps (see repository.ts). The types below mirror
 * the shape that a real ORM (e.g. Prisma) would generate — using the same
 * field names lets you swap to a real DB later without touching the indexer
 * or consumer code.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export enum TransactionStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  FAILED = 'FAILED',
  ORPHANED = 'ORPHANED',
}

// ---------------------------------------------------------------------------
// Core domain types
// ---------------------------------------------------------------------------

/**
 * A Stellar ledger transaction as stored by the indexer.
 *
 * `blockNumber` = ledger sequence number on the Stellar network.
 * `blockHash`   = ledger hash from Horizon (`/ledgers/:seq`); used for reorg
 *                 detection — if the hash we stored doesn't match the
 *                 re-fetched hash the ledger was reorganised and this row
 *                 should be marked ORPHANED.
 */
export interface BlockchainTransaction {
  id: string;
  txHash: string;
  blockNumber: number;
  /** Hex-encoded ledger hash; populated from Horizon ledger response */
  blockHash: string;
  status: TransactionStatus;
  from: string;
  to: string;
  /** Amount in XLM stroops (integer string to avoid float precision issues) */
  amount: string;
  fee: string;
  /** Raw operation type as returned by Horizon */
  operationType: string;
  memo?: string;
  /** ISO-8601 creation timestamp from the ledger */
  createdAt: string;
  /** When the indexer last wrote/updated this row */
  indexedAt: string;
  /** True once the indexer has verified the row against the chain */
  processed: boolean;
}

/**
 * A Soroban contract event emitted during a transaction.
 *
 * Composite deduplication key: (txHash, contractAddress, eventName,
 * ledgerSequence, eventIndex). eventIndex disambiguates multiple events with
 * the same name in the same transaction.
 */
export interface ContractEvent {
  id: string;
  txHash: string;
  contractAddress: string;
  eventName: string;
  /** Ledger sequence that contains this event */
  ledgerSequence: number;
  /**
   * Zero-based index of this event within the transaction's event list.
   * Added to allow multiple events with identical (txHash, contractAddress,
   * eventName) tuples — fixes the deduplication bug described in the issue.
   */
  eventIndex: number;
  /** Raw event topic/value as a JSON-serialisable object */
  parameters: Record<string, unknown>;
  /** ISO-8601 creation timestamp */
  createdAt: string;
  /** False until the fraud-detection / downstream pipeline has processed it */
  processed: boolean;
}

/**
 * Durable cursor used by the indexer to resume cleanly after restart.
 *
 * `type` is a logical name — there is currently one cursor for the ledger
 * scanner ('soroban_indexer') and one for contract events
 * ('soroban_events').
 */
export interface RollupTracker {
  type: string;
  /** Last ledger sequence successfully committed to the store */
  lastProcessedLedger: number;
  /** Soroban RPC event pagination cursor (opaque string returned by getEvents) */
  lastEventCursor: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Indexer status (returned by getIndexerStatus and the health endpoint)
// ---------------------------------------------------------------------------

export interface IndexerStatus {
  latestIndexed: number;
  latestChain: number;
  lagLedgers: number;
  isRunning: boolean;
}

// ---------------------------------------------------------------------------
// Soroban RPC wire types
// ---------------------------------------------------------------------------

/** Minimal shape returned by the Soroban RPC `getLatestLedger` method */
export interface SorobanLatestLedger {
  id: string;
  sequence: number;
  protocolVersion: number;
}

/** A single event entry from the Soroban RPC `getEvents` method */
export interface SorobanEvent {
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  id: string;
  pagingToken: string;
  topic: unknown[];
  value: unknown;
  inSuccessfulContractCall: boolean;
  /**
   * Transaction hash for this event. Always a non-empty string:
   *   - A valid 64-character lowercase hex string when the RPC node returns
   *     txHash directly, or when a fallback Horizon lookup succeeds.
   *   - A sentinel value `'unresolved:<eventId>'` when the fallback also fails,
   *     ensuring the composite deduplication key is never '' and never collides
   *     across events from different transactions.
   *
   * Callers can detect an unresolved sentinel with:
   *   `txHash.startsWith('unresolved:')`
   */
  txHash: string;
}

/** Full response shape for `getEvents` */
export interface SorobanEventsResponse {
  events: SorobanEvent[];
  latestLedger: number;
  /** Cursor for the next page; absent when there are no more pages */
  cursor?: string;
}

/** A transaction record from Horizon `GET /ledgers/:seq/transactions` */
export interface HorizonTransactionRecord {
  id: string;
  paging_token: string;
  successful: boolean;
  hash: string;
  ledger: number;
  created_at: string;
  source_account: string;
  source_account_sequence: string;
  fee_account: string;
  fee_charged: string;
  max_fee: string;
  operation_count: number;
  memo_type: string;
  memo?: string;
  /** Embedded operations (we use the first one for from/to/amount) */
  _links: {
    self: { href: string };
    account: { href: string };
    ledger: { href: string };
    operations: { href: string };
    effects: { href: string };
    precedes: { href: string };
    succeeds: { href: string };
  };
}

/** Horizon paginated response wrapper */
export interface HorizonPage<T> {
  _links: {
    self: { href: string };
    next?: { href: string };
    prev?: { href: string };
  };
  _embedded: {
    records: T[];
  };
}

/** Horizon ledger details (used for reorg detection via ledger hash) */
export interface HorizonLedger {
  id: string;
  paging_token: string;
  hash: string;
  prev_hash: string;
  sequence: number;
  successful_transaction_count: number;
  failed_transaction_count: number;
  operation_count: number;
  total_coins: string;
  fee_pool: string;
  base_fee_in_stroops: number;
  base_reserve_in_stroops: number;
  max_tx_set_size: number;
  protocol_version: number;
  closed_at: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Indexer configuration
// ---------------------------------------------------------------------------

export interface IndexerConfig {
  /** Soroban JSON-RPC endpoint URL */
  rpcUrl: string;
  /** Horizon REST API endpoint URL */
  horizonUrl: string;
  /** Soroban contract address to filter events for */
  contractAddress: string;
  /** How many ledgers to fetch in parallel per batch (default: 50) */
  batchSize: number;
  /** Max Soroban events page size — protocol cap is 200 */
  eventPageSize: number;
  /** Max in-memory event buffer size before mandatory flush */
  maxBufferSize: number;
  /** Network name for logging */
  network: string;
}

export const DEFAULT_INDEXER_CONFIG: IndexerConfig = {
  rpcUrl:
    (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_SOROBAN_RPC_TESTNET) ||
    'https://soroban-testnet.stellar.org',
  horizonUrl:
    (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_HORIZON_TESTNET) ||
    'https://horizon-testnet.stellar.org',
  contractAddress:
    (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_CAMPAIGN_MANAGER_CONTRACT) || '',
  batchSize: 50,
  eventPageSize: 200,
  maxBufferSize: 10_000,
  network: 'testnet',
};
