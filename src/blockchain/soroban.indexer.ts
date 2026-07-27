/**
 * SorobanIndexer — production-grade Soroban/Stellar ledger indexer.
 *
 * Responsibilities:
 *   1. Scan all ledgers from the last-persisted cursor to the chain head
 *      using batched parallel Horizon calls (indexLatestTransactions).
 *   2. Fetch all Soroban contract events via cursor-based RPC pagination
 *      with composite-key deduplication (indexContractEvents).
 *   3. Detect and mark orphaned transactions after a chain reorganisation.
 *   4. Persist a durable cursor (RollupTracker) after every committed batch
 *      so restarts resume cleanly.
 *   5. Expose getIndexerStatus() for health monitoring.
 *
 * Design constraints honoured:
 *   - No DB transaction held open across multiple RPC calls.
 *   - In-memory event buffer flushed before reaching 10 000 items.
 *   - Composite deduplication key: (txHash, contractAddress, eventName,
 *     ledgerSequence, eventIndex).
 *   - ≥ 100 ledgers/sec throughput via window-parallel fetch.
 *   - Public indexTransaction / indexEvent signatures unchanged.
 */

import { randomUUID } from 'crypto';
import type { IndexerConfig, IndexerStatus } from './types';
import { TransactionStatus, DEFAULT_INDEXER_CONFIG } from './types';
import type { HorizonTransactionRecord } from './types';
import {
  blockchainTransactionRepo,
  contractEventRepo,
  rollupTrackerRepo,
} from './repository';
import {
  getLatestLedger,
  getLedgerDetails,
  batchGetLedgerTransactions,
  paginateEvents,
  parseEventIndex,
  parseEventName,
} from './rpc-client';

// ---------------------------------------------------------------------------
// Logger (lightweight — avoids pulling in a third-party log library)
// ---------------------------------------------------------------------------

const logger = {
  debug: (msg: string, ctx?: Record<string, unknown>) =>
    process.env.NODE_ENV !== 'test' &&
    console.debug(`[SorobanIndexer] ${msg}`, ctx ?? ''),
  info: (msg: string, ctx?: Record<string, unknown>) =>
    console.info(`[SorobanIndexer] ${msg}`, ctx ?? ''),
  warn: (msg: string, ctx?: Record<string, unknown>) =>
    console.warn(`[SorobanIndexer] ${msg}`, ctx ?? ''),
  error: (msg: string, ctx?: Record<string, unknown>) =>
    console.error(`[SorobanIndexer] ${msg}`, ctx ?? ''),
};

// ---------------------------------------------------------------------------
// Cursor type keys
// ---------------------------------------------------------------------------

const CURSOR_LEDGER = 'soroban_indexer';
const CURSOR_EVENTS = 'soroban_events';

// ---------------------------------------------------------------------------
// SorobanIndexer
// ---------------------------------------------------------------------------

export class SorobanIndexer {
  private readonly config: IndexerConfig;
  private isRunning = false;
  private latestIndexedLedger = 0;
  private latestChainLedger = 0;

  /**
   * In-memory write buffer for ContractEvent rows.
   * Flushed to the store when it reaches maxBufferSize or at the end of a
   * pagination sweep.  Prevents unbounded memory growth during a large
   * backfill.
   */
  private eventBuffer: Parameters<typeof contractEventRepo.upsert>[0][] = [];

  constructor(config: Partial<IndexerConfig> = {}) {
    this.config = { ...DEFAULT_INDEXER_CONFIG, ...config };
  }

  // -------------------------------------------------------------------------
  // Public: indexLatestTransactions
  // -------------------------------------------------------------------------

  /**
   * Fetches all ledgers from the last committed cursor to the current chain
   * head and upserts BlockchainTransaction rows.
   *
   * Algorithm:
   *   1. Read chain head via Soroban RPC getLatestLedger.
   *   2. Read the last indexed ledger from RollupTracker (cursor).
   *   3. Divide [startLedger, latestLedger] into windows of config.batchSize.
   *   4. For each window, fetch all transactions in parallel from Horizon.
   *   5. Upsert transactions and advance the cursor after each window.
   *   6. Before committing each batch, call detectAndMarkReorgs() to orphan
   *      any previously-stored rows whose ledger hash has changed.
   */
  async indexLatestTransactions(): Promise<void> {
    this.isRunning = true;
    try {
      const latestLedger = await getLatestLedger(this.config.rpcUrl);
      this.latestChainLedger = latestLedger.sequence;

      const tracker = rollupTrackerRepo.findOrCreate(CURSOR_LEDGER);
      const startLedger = tracker.lastProcessedLedger > 0
        ? tracker.lastProcessedLedger + 1
        : Math.max(1, latestLedger.sequence - this.config.batchSize);

      if (startLedger > latestLedger.sequence) {
        logger.debug('Already at chain head', {
          startLedger,
          latestLedger: latestLedger.sequence,
        });
        return;
      }

      logger.info('Starting ledger scan', {
        startLedger,
        endLedger: latestLedger.sequence,
        total: latestLedger.sequence - startLedger + 1,
      });

      const { batchSize } = this.config;

      for (
        let batchStart = startLedger;
        batchStart <= latestLedger.sequence;
        batchStart += batchSize
      ) {
        const batchEnd = Math.min(batchStart + batchSize - 1, latestLedger.sequence);
        const ledgerRange = Array.from(
          { length: batchEnd - batchStart + 1 },
          (_, i) => batchStart + i
        );

        // ------------------------------------------------------------------
        // Step A: Reorg detection — compare stored blockHash against Horizon
        // for any ledgers we have already indexed.
        // ------------------------------------------------------------------
        await this.detectAndMarkReorgs(ledgerRange);

        // ------------------------------------------------------------------
        // Step B: Fetch transactions for this window in parallel.
        // ------------------------------------------------------------------
        const txMap = await batchGetLedgerTransactions(
          this.config.horizonUrl,
          ledgerRange,
          this.config.batchSize
        );

        // ------------------------------------------------------------------
        // Step C: Upsert all transactions.
        // No DB transaction is held open — each upsert is synchronous and
        // atomic at the row level.
        // ------------------------------------------------------------------
        let batchCount = 0;
        for (const [ledgerSeq, records] of txMap.entries()) {
          // Fetch the ledger hash for this sequence so we can detect future reorgs
          let ledgerHash = '';
          try {
            const ledgerDetail = await getLedgerDetails(this.config.horizonUrl, ledgerSeq);
            ledgerHash = ledgerDetail.hash;
          } catch {
            logger.warn('Could not fetch ledger details for hash', { ledgerSeq });
          }

          for (const record of records) {
            this.upsertTransaction(record, ledgerSeq, ledgerHash);
            batchCount++;
          }
        }

        // ------------------------------------------------------------------
        // Step D: Advance the durable cursor after each committed window.
        // This means a crash mid-scan loses at most one window of ledgers,
        // not the entire run.
        // ------------------------------------------------------------------
        rollupTrackerRepo.upsert(CURSOR_LEDGER, {
          lastProcessedLedger: batchEnd,
        });
        this.latestIndexedLedger = batchEnd;

        logger.debug('Committed ledger batch', {
          batchStart,
          batchEnd,
          txCount: batchCount,
        });
      }

      logger.info('Ledger scan complete', {
        latestIndexed: this.latestIndexedLedger,
        latestChain: this.latestChainLedger,
      });
    } finally {
      this.isRunning = false;
    }
  }

  // -------------------------------------------------------------------------
  // Public: indexContractEvents
  // -------------------------------------------------------------------------

  /**
   * Fetches all Soroban contract events for the configured contract address
   * using cursor-based pagination (max page 200) and upserts ContractEvent
   * rows with composite deduplication.
   *
   * Algorithm:
   *   1. Read the last event cursor from RollupTracker.
   *   2. Call paginateEvents(), buffering each page.
   *   3. Flush the buffer to the store whenever it reaches maxBufferSize.
   *   4. Persist the updated cursor after each page commit.
   */
  async indexContractEvents(): Promise<void> {
    this.isRunning = true;
    try {
      const tracker = rollupTrackerRepo.findOrCreate(CURSOR_EVENTS);
      const ledgerTracker = rollupTrackerRepo.findOrCreate(CURSOR_LEDGER);

      // Determine start ledger for the events scan.
      // If we have a ledger cursor use that; otherwise start 100 ledgers back.
      const latestLedger = await getLatestLedger(this.config.rpcUrl);
      this.latestChainLedger = latestLedger.sequence;

      const startLedger =
        ledgerTracker.lastProcessedLedger > 0
          ? ledgerTracker.lastProcessedLedger
          : Math.max(1, latestLedger.sequence - 100);

      logger.info('Starting event scan', {
        startLedger,
        contractAddress: this.config.contractAddress,
        hasCursor: !!tracker.lastEventCursor,
      });

      let pageCount = 0;

      const { finalCursor } = await paginateEvents(this.config.rpcUrl, {
        startLedger,
        contractAddress: this.config.contractAddress,
        limit: this.config.eventPageSize,
        initialCursor: tracker.lastEventCursor || undefined,
        onPage: async (page) => {
          pageCount++;

          for (const event of page.events) {
            const txHash = event.txHash ?? '';
            const contractAddress = event.contractId;
            const eventName = parseEventName(event.topic);
            const eventIndex = parseEventIndex(event.id);
            const parameters: Record<string, unknown> = {
              topic: event.topic,
              value: event.value,
              type: event.type,
            };

            this.eventBuffer.push({
              txHash,
              contractAddress,
              eventName,
              ledgerSequence: event.ledger,
              eventIndex,
              parameters,
              processed: false,
            });

            // Flush before hitting the in-memory buffer cap
            if (this.eventBuffer.length >= this.config.maxBufferSize) {
              this.flushEventBuffer();
            }
          }

          // Persist the cursor after each page so we resume cleanly on crash
          if (page.cursor) {
            rollupTrackerRepo.upsert(CURSOR_EVENTS, {
              lastEventCursor: page.cursor,
            });
          }

          logger.debug('Processed event page', {
            pageNumber: pageCount,
            eventsInPage: page.events.length,
            bufferSize: this.eventBuffer.length,
          });

          return true; // continue to next page
        },
      });

      // Flush any remaining events in the buffer
      this.flushEventBuffer();

      // Persist the final cursor
      if (finalCursor) {
        rollupTrackerRepo.upsert(CURSOR_EVENTS, {
          lastEventCursor: finalCursor,
        });
      }

      logger.info('Event scan complete', {
        pages: pageCount,
        totalEvents: contractEventRepo.count(),
        finalCursor,
      });
    } finally {
      this.isRunning = false;
    }
  }

  // -------------------------------------------------------------------------
  // Public: indexTransaction (legacy / application-code entry point)
  //
  // Signature MUST NOT change — called by POST /api/v1/donations/:id/confirm
  // and POST /api/v1/distributions/:id/confirm.
  // -------------------------------------------------------------------------

  /**
   * Records a single transaction submitted by application code.
   * The txHash is stored immediately as CONFIRMED so downstream consumers
   * can find it; the indexer will re-validate it on the next ledger scan.
   */
  indexTransaction(
    txHash: string,
    blockNumber: number,
    meta: {
      from?: string;
      to?: string;
      amount?: string;
      fee?: string;
      operationType?: string;
      memo?: string;
    } = {}
  ): void {
    blockchainTransactionRepo.upsert({
      txHash,
      blockNumber,
      blockHash: '', // unknown until the next ledger scan
      status: TransactionStatus.CONFIRMED,
      from: meta.from ?? '',
      to: meta.to ?? '',
      amount: meta.amount ?? '0',
      fee: meta.fee ?? '0',
      operationType: meta.operationType ?? 'unknown',
      memo: meta.memo,
      createdAt: new Date().toISOString(),
      processed: false,
    });

    logger.debug('Indexed application transaction', { txHash, blockNumber });
  }

  // -------------------------------------------------------------------------
  // Public: indexEvent (legacy / application-code entry point)
  //
  // Signature MUST NOT change.
  // -------------------------------------------------------------------------

  /**
   * Records a single contract event submitted by application code.
   * Uses the same composite-key deduplication as the bulk scanner.
   */
  indexEvent(
    txHash: string,
    contractAddress: string,
    eventName: string,
    ledgerSequence: number,
    eventIndex: number,
    parameters: Record<string, unknown> = {}
  ): void {
    contractEventRepo.upsert({
      txHash,
      contractAddress,
      eventName,
      ledgerSequence,
      eventIndex,
      parameters,
      processed: false,
    });

    logger.debug('Indexed application event', {
      txHash,
      contractAddress,
      eventName,
      eventIndex,
    });
  }

  // -------------------------------------------------------------------------
  // Public: getIndexerStatus
  // -------------------------------------------------------------------------

  /**
   * Returns the current indexer health metrics.
   * Consumed by GET /api/v1/admin/health.
   */
  getIndexerStatus(): IndexerStatus {
    const tracker = rollupTrackerRepo.find(CURSOR_LEDGER);
    const latestIndexed = tracker?.lastProcessedLedger ?? this.latestIndexedLedger;

    return {
      latestIndexed,
      latestChain: this.latestChainLedger,
      lagLedgers: Math.max(0, this.latestChainLedger - latestIndexed),
      isRunning: this.isRunning,
    };
  }

  // -------------------------------------------------------------------------
  // Private: reorg detection
  // -------------------------------------------------------------------------

  /**
   * For any ledger in `ledgerRange` that we have already indexed, re-fetch
   * the Horizon ledger hash and orphan our rows if the hash has changed.
   *
   * We only check ledgers we have at least one transaction stored for —
   * empty ledgers have no rows to orphan.
   */
  private async detectAndMarkReorgs(ledgerRange: number[]): Promise<void> {
    // Find ledgers in this range that we have rows for
    const indexedLedgers = new Set<number>();
    for (const seq of ledgerRange) {
      const txs = blockchainTransactionRepo.findByLedger(seq);
      if (txs.length > 0) indexedLedgers.add(seq);
    }

    if (indexedLedgers.size === 0) return;

    await Promise.allSettled(
      Array.from(indexedLedgers).map(async (seq) => {
        try {
          const [existing] = blockchainTransactionRepo.findByLedger(seq);
          if (!existing || !existing.blockHash) return;

          const canonical = await getLedgerDetails(this.config.horizonUrl, seq);
          if (canonical.hash !== existing.blockHash) {
            logger.warn('Reorg detected — orphaning ledger', {
              seq,
              storedHash: existing.blockHash,
              canonicalHash: canonical.hash,
            });
            blockchainTransactionRepo.orphanByLedger(seq);
          }
        } catch {
          // Network error during reorg check — skip; will retry next cycle
        }
      })
    );
  }

  // -------------------------------------------------------------------------
  // Private: event buffer flush
  // -------------------------------------------------------------------------

  /**
   * Drains the in-memory event buffer into the ContractEvent store.
   * Each event is upserted with the composite deduplication key — duplicate
   * events silently no-op.
   */
  private flushEventBuffer(): void {
    const count = this.eventBuffer.length;
    if (count === 0) return;

    for (const event of this.eventBuffer) {
      contractEventRepo.upsert(event);
    }

    this.eventBuffer = [];
    logger.debug('Flushed event buffer', { count });
  }

  // -------------------------------------------------------------------------
  // Private: transaction upsert helper
  // -------------------------------------------------------------------------

  private upsertTransaction(
    record: HorizonTransactionRecord,
    ledgerSeq: number,
    ledgerHash: string
  ): void {
    blockchainTransactionRepo.upsert({
      txHash: record.hash,
      blockNumber: ledgerSeq,
      blockHash: ledgerHash,
      status: record.successful ? TransactionStatus.CONFIRMED : TransactionStatus.FAILED,
      from: record.source_account,
      to: record.fee_account ?? record.source_account,
      amount: '0', // amount requires parsing the XDR envelope; use '0' as safe default
      fee: record.fee_charged,
      operationType: record.operation_count > 0 ? 'multi' : 'none',
      memo: record.memo,
      createdAt: record.created_at,
      processed: false,
    });
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton (shared across API routes in the same Node process)
// ---------------------------------------------------------------------------

let _indexer: SorobanIndexer | null = null;

/**
 * Returns the singleton SorobanIndexer instance for the current process.
 * The instance is created lazily on first call and cached thereafter,
 * consistent with the getSorobanSDK() pattern in src/lib/soroban/sdk.ts.
 */
export function getSorobanIndexer(config?: Partial<IndexerConfig>): SorobanIndexer {
  if (!_indexer) {
    _indexer = new SorobanIndexer(config);
  }
  return _indexer;
}

/** Test-only: reset the singleton so tests get fresh instances */
export function __resetIndexerSingleton(): void {
  _indexer = null;
}

export { randomUUID };
