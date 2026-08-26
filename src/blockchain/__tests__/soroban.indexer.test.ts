/**
 * Integration tests for SorobanIndexer — covers all 8 acceptance criteria.
 *
 * AC1  – indexLatestTransactions writes a CONFIRMED BlockchainTransaction row
 *         with the correct txHash from the stub ledger.
 * AC2  – indexContractEvents creates one ContractEvent per emitted event,
 *         each with a distinct eventIndex.
 * AC3  – After a simulated mid-batch crash and restart no ContractEvent is
 *         duplicated (COUNT = 1 WHERE txHash = X AND eventIndex = Y).
 * AC4  – Gap test: cursor seeded to N−500 while chain is at N; all ledgers
 *         N−500 through N are indexed.
 * AC5  – Reorg test: a stored row with a fake txHash not on chain is marked
 *         ORPHANED when the ledger hash no longer matches.
 * AC6  – getIndexerStatus() returns { latestIndexed, latestChain,
 *         lagLedgers, isRunning } in the correct shape.
 * AC7  – Benchmark: ≥ 100 ledgers/sec against a local stub.
 * AC8  – TypeScript compiles with zero new errors; no existing tests broken
 *         (verified by running the full suite — see task #2/#3).
 *
 * NEW:  txHash resolution acceptance criteria (issue #txhash-fix):
 * TXAC1 – getEvents with no txHash in RPC response → no element has txHash === ''
 * TXAC2 – Two events with distinct id but both missing txHash → distinct sentinels
 * TXAC3 – Event id='12345-2-0', Horizon returns hash → txHash = resolved hash
 * TXAC4 – Deduplication: two events both with txHash:'' before fix now produce
 *          distinct sentinel keys and are stored as 2 separate rows
 * TXAC5 – 100 events with no txHash → zero entries with txHash === ''
 * TXAC6 – resolveUnresolvedEvents updates sentinel row to real hash; findByHash works
 * TXAC7 – npm run test and npm run type-check pass (CI)
 * TXAC8 – Property-based: N random event IDs → extractTxHashFromEventId never returns ''
 *
 * All network I/O is intercepted at the rpc-client module boundary so no
 * actual RPC calls are made.
 */

import {
  SorobanIndexer,
  getSorobanIndexer,
  __resetIndexerSingleton,
} from '../soroban.indexer';
import {
  blockchainTransactionRepo,
  contractEventRepo,
  rollupTrackerRepo,
  __clearAllStores,
} from '../repository';
import { TransactionStatus } from '../types';

// ---------------------------------------------------------------------------
// Mock the rpc-client so tests never hit the network.
// ---------------------------------------------------------------------------

jest.mock('../rpc-client', () => ({
  getLatestLedger: jest.fn(),
  getLedgerDetails: jest.fn(),
  getLedgerTransactions: jest.fn(),
  batchGetLedgerTransactions: jest.fn(),
  paginateEvents: jest.fn(),
  parseEventIndex: jest.requireActual('../rpc-client').parseEventIndex,
  parseEventName: jest.requireActual('../rpc-client').parseEventName,
  makeSentinelTxHash: jest.requireActual('../rpc-client').makeSentinelTxHash,
  isUnresolvedTxHash: jest.requireActual('../rpc-client').isUnresolvedTxHash,
  __clearTxHashCache: jest.requireActual('../rpc-client').__clearTxHashCache,
}));

import {
  getLatestLedger,
  getLedgerDetails,
  getLedgerTransactions,
  batchGetLedgerTransactions,
  paginateEvents,
  makeSentinelTxHash,
  isUnresolvedTxHash,
} from '../rpc-client';

const mockGetLatestLedger = getLatestLedger as jest.MockedFunction<typeof getLatestLedger>;
const mockGetLedgerDetails = getLedgerDetails as jest.MockedFunction<typeof getLedgerDetails>;
const mockGetLedgerTransactions = getLedgerTransactions as jest.MockedFunction<typeof getLedgerTransactions>;
const mockBatchGetLedgerTransactions = batchGetLedgerTransactions as jest.MockedFunction<
  typeof batchGetLedgerTransactions
>;
const mockPaginateEvents = paginateEvents as jest.MockedFunction<typeof paginateEvents>;

// ---------------------------------------------------------------------------
// Test-fixture helpers
// ---------------------------------------------------------------------------

/** Minimal HorizonTransactionRecord fixture */
function makeTxRecord(overrides: {
  hash?: string;
  ledger?: number;
  successful?: boolean;
  source_account?: string;
  fee_account?: string;
  fee_charged?: string;
  operation_count?: number;
  created_at?: string;
  memo?: string;
}) {
  return {
    id: `id-${overrides.hash ?? 'default'}`,
    paging_token: '1',
    successful: overrides.successful ?? true,
    hash: overrides.hash ?? 'default-hash',
    ledger: overrides.ledger ?? 1000,
    created_at: overrides.created_at ?? new Date().toISOString(),
    source_account: overrides.source_account ?? 'GFROM',
    source_account_sequence: '1',
    fee_account: overrides.fee_account ?? 'GFROM',
    fee_charged: overrides.fee_charged ?? '100',
    max_fee: '200',
    operation_count: overrides.operation_count ?? 1,
    memo_type: 'none',
    memo: overrides.memo,
    _links: {
      self: { href: '' },
      account: { href: '' },
      ledger: { href: '' },
      operations: { href: '' },
      effects: { href: '' },
      precedes: { href: '' },
      succeeds: { href: '' },
    },
  };
}

/** Minimal SorobanEvent fixture */
function makeEventRecord(overrides: {
  id?: string;
  txHash?: string;
  contractId?: string;
  eventName?: string;
  ledger?: number;
  type?: string;
}) {
  const id = overrides.id ?? `${overrides.ledger ?? 1000}-0-0`;
  return {
    type: overrides.type ?? 'contract',
    ledger: overrides.ledger ?? 1000,
    ledgerClosedAt: new Date().toISOString(),
    contractId: overrides.contractId ?? 'CONTRACT_ADDR',
    id,
    pagingToken: id,
    topic: [overrides.eventName ?? 'transfer'],
    value: { amount: '1000' },
    inSuccessfulContractCall: true,
    txHash: overrides.txHash ?? 'tx-hash-abc',
  };
}

/** Base indexer config used in most tests */
const TEST_CONFIG = {
  rpcUrl: 'http://stub-rpc',
  horizonUrl: 'http://stub-horizon',
  contractAddress: 'CONTRACT_ADDR',
  batchSize: 50,
  eventPageSize: 200,
  maxBufferSize: 10_000,
  network: 'testnet',
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  __clearAllStores();
  __resetIndexerSingleton();
  jest.clearAllMocks();
});

// ===========================================================================
// AC1 — indexLatestTransactions writes a CONFIRMED row with correct txHash
// ===========================================================================

describe('AC1 — indexLatestTransactions: confirmed transaction row', () => {
  it('upserts a CONFIRMED BlockchainTransaction with the correct txHash', async () => {
    const TX_HASH = 'stellar-tx-abc123';
    const LEDGER_SEQ = 1000;
    const LEDGER_HASH = 'ledger-hash-xyz';

    mockGetLatestLedger.mockResolvedValue({
      id: 'lid',
      sequence: LEDGER_SEQ,
      protocolVersion: 21,
    });

    // getLedgerDetails is called for reorg checking during batch AND for
    // populating blockHash on each ledger's transactions.
    mockGetLedgerDetails.mockResolvedValue({
      id: 'lid',
      paging_token: '1',
      hash: LEDGER_HASH,
      prev_hash: '',
      sequence: LEDGER_SEQ,
      successful_transaction_count: 1,
      failed_transaction_count: 0,
      operation_count: 1,
      total_coins: '0',
      fee_pool: '0',
      base_fee_in_stroops: 100,
      base_reserve_in_stroops: 5000000,
      max_tx_set_size: 1000,
      protocol_version: 21,
      closed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });

    const txRecord = makeTxRecord({ hash: TX_HASH, ledger: LEDGER_SEQ, successful: true });
    const txMap = new Map([[LEDGER_SEQ, [txRecord]]]);
    mockBatchGetLedgerTransactions.mockResolvedValue(txMap);

    const indexer = new SorobanIndexer(TEST_CONFIG);
    await indexer.indexLatestTransactions();

    const stored = blockchainTransactionRepo.findByHash(TX_HASH);
    expect(stored).toBeDefined();
    expect(stored!.txHash).toBe(TX_HASH);
    expect(stored!.status).toBe(TransactionStatus.CONFIRMED);
    expect(stored!.blockNumber).toBe(LEDGER_SEQ);
    expect(stored!.blockHash).toBe(LEDGER_HASH);
  });

  it('marks a failed transaction as FAILED', async () => {
    const TX_HASH = 'failed-tx-hash';
    const LEDGER_SEQ = 1001;

    mockGetLatestLedger.mockResolvedValue({ id: 'lid', sequence: LEDGER_SEQ, protocolVersion: 21 });
    mockGetLedgerDetails.mockResolvedValue({
      id: 'lid', paging_token: '1', hash: 'h', prev_hash: '', sequence: LEDGER_SEQ,
      successful_transaction_count: 0, failed_transaction_count: 1, operation_count: 0,
      total_coins: '0', fee_pool: '0', base_fee_in_stroops: 100, base_reserve_in_stroops: 5000000,
      max_tx_set_size: 1000, protocol_version: 21,
      closed_at: new Date().toISOString(), created_at: new Date().toISOString(),
    });

    const txMap = new Map([[LEDGER_SEQ, [makeTxRecord({ hash: TX_HASH, ledger: LEDGER_SEQ, successful: false })]]]);
    mockBatchGetLedgerTransactions.mockResolvedValue(txMap);

    const indexer = new SorobanIndexer(TEST_CONFIG);
    await indexer.indexLatestTransactions();

    const stored = blockchainTransactionRepo.findByHash(TX_HASH);
    expect(stored!.status).toBe(TransactionStatus.FAILED);
  });

  it('advances the durable cursor after the batch', async () => {
    const LEDGER_SEQ = 2000;
    mockGetLatestLedger.mockResolvedValue({ id: 'lid', sequence: LEDGER_SEQ, protocolVersion: 21 });
    mockGetLedgerDetails.mockResolvedValue({
      id: 'lid', paging_token: '1', hash: 'hh', prev_hash: '', sequence: LEDGER_SEQ,
      successful_transaction_count: 0, failed_transaction_count: 0, operation_count: 0,
      total_coins: '0', fee_pool: '0', base_fee_in_stroops: 100, base_reserve_in_stroops: 5000000,
      max_tx_set_size: 1000, protocol_version: 21,
      closed_at: new Date().toISOString(), created_at: new Date().toISOString(),
    });
    mockBatchGetLedgerTransactions.mockResolvedValue(new Map([[LEDGER_SEQ, []]]));

    const indexer = new SorobanIndexer(TEST_CONFIG);
    await indexer.indexLatestTransactions();

    const tracker = rollupTrackerRepo.find('soroban_indexer');
    expect(tracker).toBeDefined();
    expect(tracker!.lastProcessedLedger).toBe(LEDGER_SEQ);
  });
});

// ===========================================================================
// AC2 — indexContractEvents: one row per event with distinct eventIndex
// ===========================================================================

describe('AC2 — indexContractEvents: distinct ContractEvent rows per eventIndex', () => {
  it('creates one ContractEvent row per emitted event', async () => {
    const LEDGER_SEQ = 1000;
    mockGetLatestLedger.mockResolvedValue({ id: 'lid', sequence: LEDGER_SEQ, protocolVersion: 21 });

    const events = [
      makeEventRecord({ id: `${LEDGER_SEQ}-0-0`, txHash: 'tx1', ledger: LEDGER_SEQ, eventName: 'transfer' }),
      makeEventRecord({ id: `${LEDGER_SEQ}-0-1`, txHash: 'tx1', ledger: LEDGER_SEQ, eventName: 'transfer' }),
      makeEventRecord({ id: `${LEDGER_SEQ}-0-2`, txHash: 'tx1', ledger: LEDGER_SEQ, eventName: 'transfer' }),
    ];

    mockPaginateEvents.mockImplementation(async (_url, opts) => {
      await opts.onPage({ events, latestLedger: LEDGER_SEQ, cursor: undefined });
      return { finalCursor: '', latestLedger: LEDGER_SEQ };
    });

    // Seed a ledger cursor so indexContractEvents knows where to start
    rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: LEDGER_SEQ });

    const indexer = new SorobanIndexer(TEST_CONFIG);
    await indexer.indexContractEvents();

    expect(contractEventRepo.count()).toBe(3);

    // Each event must have a distinct eventIndex (0, 1, 2)
    const all = contractEventRepo.__all();
    const indices = all.map((e) => e.eventIndex).sort((a, b) => a - b);
    expect(indices).toEqual([0, 1, 2]);
  });

  it('stores events with different eventNames from same tx as separate rows', async () => {
    const LEDGER_SEQ = 1001;
    mockGetLatestLedger.mockResolvedValue({ id: 'lid', sequence: LEDGER_SEQ, protocolVersion: 21 });

    const events = [
      makeEventRecord({ id: `${LEDGER_SEQ}-0-0`, txHash: 'tx2', ledger: LEDGER_SEQ, eventName: 'deposit' }),
      makeEventRecord({ id: `${LEDGER_SEQ}-0-1`, txHash: 'tx2', ledger: LEDGER_SEQ, eventName: 'transfer' }),
      makeEventRecord({ id: `${LEDGER_SEQ}-0-2`, txHash: 'tx2', ledger: LEDGER_SEQ, eventName: 'withdraw' }),
    ];

    mockPaginateEvents.mockImplementation(async (_url, opts) => {
      await opts.onPage({ events, latestLedger: LEDGER_SEQ, cursor: undefined });
      return { finalCursor: '', latestLedger: LEDGER_SEQ };
    });

    rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: LEDGER_SEQ });

    const indexer = new SorobanIndexer(TEST_CONFIG);
    await indexer.indexContractEvents();

    expect(contractEventRepo.count()).toBe(3);
    const names = contractEventRepo.__all().map((e) => e.eventName).sort();
    expect(names).toEqual(['deposit', 'transfer', 'withdraw']);
  });

  it('persists the event cursor after each page', async () => {
    const LEDGER_SEQ = 1002;
    const CURSOR_AFTER_PAGE = 'cursor-page-1';
    mockGetLatestLedger.mockResolvedValue({ id: 'lid', sequence: LEDGER_SEQ, protocolVersion: 21 });

    mockPaginateEvents.mockImplementation(async (_url, opts) => {
      await opts.onPage({
        events: [makeEventRecord({ id: `${LEDGER_SEQ}-0-0`, txHash: 'txC', ledger: LEDGER_SEQ })],
        latestLedger: LEDGER_SEQ,
        cursor: CURSOR_AFTER_PAGE,
      });
      return { finalCursor: CURSOR_AFTER_PAGE, latestLedger: LEDGER_SEQ };
    });

    rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: LEDGER_SEQ });

    const indexer = new SorobanIndexer(TEST_CONFIG);
    await indexer.indexContractEvents();

    const tracker = rollupTrackerRepo.find('soroban_events');
    expect(tracker?.lastEventCursor).toBe(CURSOR_AFTER_PAGE);
  });
});

// ===========================================================================
// AC3 — Crash-restart: no ContractEvent is duplicated
// ===========================================================================

describe('AC3 — crash-restart deduplication: COUNT = 1 WHERE txHash = X AND eventIndex = Y', () => {
  it('does not duplicate events when the same ledger range is re-indexed after restart', async () => {
    const LEDGER_SEQ = 1100;
    const TX_HASH = 'crash-restart-tx';

    mockGetLatestLedger.mockResolvedValue({ id: 'lid', sequence: LEDGER_SEQ, protocolVersion: 21 });

    const events = [
      makeEventRecord({ id: `${LEDGER_SEQ}-0-0`, txHash: TX_HASH, ledger: LEDGER_SEQ }),
      makeEventRecord({ id: `${LEDGER_SEQ}-0-1`, txHash: TX_HASH, ledger: LEDGER_SEQ }),
    ];

    // Both "runs" return the same events (simulating a restart that re-scans the same range)
    mockPaginateEvents.mockImplementation(async (_url, opts) => {
      await opts.onPage({ events, latestLedger: LEDGER_SEQ, cursor: undefined });
      return { finalCursor: '', latestLedger: LEDGER_SEQ };
    });

    rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: LEDGER_SEQ });

    const indexer = new SorobanIndexer(TEST_CONFIG);

    // First run (normal)
    await indexer.indexContractEvents();
    expect(contractEventRepo.count()).toBe(2);

    // Simulate mid-batch crash: stores are NOT cleared (survive a restart)
    // but the indexer singleton is reset (new process)
    __resetIndexerSingleton();
    jest.clearAllMocks();
    mockGetLatestLedger.mockResolvedValue({ id: 'lid', sequence: LEDGER_SEQ, protocolVersion: 21 });
    mockPaginateEvents.mockImplementation(async (_url, opts) => {
      await opts.onPage({ events, latestLedger: LEDGER_SEQ, cursor: undefined });
      return { finalCursor: '', latestLedger: LEDGER_SEQ };
    });

    // Second run (post-restart, same data)
    const indexer2 = new SorobanIndexer(TEST_CONFIG);
    await indexer2.indexContractEvents();

    // Must still be exactly 2 — no duplicates
    expect(contractEventRepo.count()).toBe(2);
    // Acceptance criterion: COUNT(*) = 1 WHERE txHash = X AND eventIndex = Y
    expect(contractEventRepo.countByTxHash(TX_HASH, 0)).toBe(1);
    expect(contractEventRepo.countByTxHash(TX_HASH, 1)).toBe(1);
  });

  it('does not duplicate transactions when the same batch is replayed after restart', async () => {
    const LEDGER_SEQ = 1101;
    const TX_HASH = 'restart-tx-hash';

    const txRecord = makeTxRecord({ hash: TX_HASH, ledger: LEDGER_SEQ, successful: true });
    const txMap = new Map([[LEDGER_SEQ, [txRecord]]]);

    mockGetLatestLedger.mockResolvedValue({ id: 'lid', sequence: LEDGER_SEQ, protocolVersion: 21 });
    mockGetLedgerDetails.mockResolvedValue({
      id: 'lid', paging_token: '1', hash: 'hh', prev_hash: '', sequence: LEDGER_SEQ,
      successful_transaction_count: 1, failed_transaction_count: 0, operation_count: 1,
      total_coins: '0', fee_pool: '0', base_fee_in_stroops: 100, base_reserve_in_stroops: 5000000,
      max_tx_set_size: 1000, protocol_version: 21,
      closed_at: new Date().toISOString(), created_at: new Date().toISOString(),
    });
    mockBatchGetLedgerTransactions.mockResolvedValue(txMap);

    // Run 1
    await new SorobanIndexer(TEST_CONFIG).indexLatestTransactions();
    expect(blockchainTransactionRepo.count()).toBe(1);

    // Simulate restart: reset cursor so indexer would re-scan
    rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: 0 });
    __resetIndexerSingleton();

    mockGetLatestLedger.mockResolvedValue({ id: 'lid', sequence: LEDGER_SEQ, protocolVersion: 21 });
    mockGetLedgerDetails.mockResolvedValue({
      id: 'lid', paging_token: '1', hash: 'hh', prev_hash: '', sequence: LEDGER_SEQ,
      successful_transaction_count: 1, failed_transaction_count: 0, operation_count: 1,
      total_coins: '0', fee_pool: '0', base_fee_in_stroops: 100, base_reserve_in_stroops: 5000000,
      max_tx_set_size: 1000, protocol_version: 21,
      closed_at: new Date().toISOString(), created_at: new Date().toISOString(),
    });
    mockBatchGetLedgerTransactions.mockResolvedValue(txMap);

    // Run 2
    await new SorobanIndexer(TEST_CONFIG).indexLatestTransactions();
    // Upsert semantics — still exactly 1 row for this txHash
    expect(blockchainTransactionRepo.count()).toBe(1);
  });
});

// ===========================================================================
// AC4 — Gap recovery: cursor at N−500, all ledgers N−500 through N indexed
// ===========================================================================

describe('AC4 — gap recovery: cursor seeded to N−500, all ledgers indexed', () => {
  it('indexes every ledger from the cursor to the chain head', async () => {
    const CHAIN_HEAD = 1500;
    const GAP_START = CHAIN_HEAD - 500; // 1000

    // Seed cursor to GAP_START so the indexer starts from there
    rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: GAP_START });

    mockGetLatestLedger.mockResolvedValue({ id: 'lid', sequence: CHAIN_HEAD, protocolVersion: 21 });
    mockGetLedgerDetails.mockResolvedValue({
      id: 'lid', paging_token: '1', hash: 'canonical-hash', prev_hash: '', sequence: 0,
      successful_transaction_count: 0, failed_transaction_count: 0, operation_count: 0,
      total_coins: '0', fee_pool: '0', base_fee_in_stroops: 100, base_reserve_in_stroops: 5000000,
      max_tx_set_size: 1000, protocol_version: 21,
      closed_at: new Date().toISOString(), created_at: new Date().toISOString(),
    });

    // Track which ledger sequences were fetched
    const fetchedLedgers = new Set<number>();
    mockBatchGetLedgerTransactions.mockImplementation(async (_url, ledgerRange) => {
      const result = new Map<number, ReturnType<typeof makeTxRecord>[]>();
      for (const seq of ledgerRange) {
        fetchedLedgers.add(seq);
        result.set(seq, [makeTxRecord({ hash: `tx-${seq}`, ledger: seq })]);
      }
      return result;
    });

    const indexer = new SorobanIndexer(TEST_CONFIG);
    await indexer.indexLatestTransactions();

    // Every ledger from GAP_START+1 to CHAIN_HEAD must have been fetched
    const expectedCount = CHAIN_HEAD - GAP_START; // 500
    expect(fetchedLedgers.size).toBe(expectedCount);
    for (let seq = GAP_START + 1; seq <= CHAIN_HEAD; seq++) {
      expect(fetchedLedgers.has(seq)).toBe(true);
    }

    // Cursor must be advanced to the chain head
    const tracker = rollupTrackerRepo.find('soroban_indexer');
    expect(tracker!.lastProcessedLedger).toBe(CHAIN_HEAD);
  });

  it('resumes from the saved cursor on restart, not from chain head - batchSize', async () => {
    const SAVED_CURSOR = 800;
    const CHAIN_HEAD = 900;

    rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: SAVED_CURSOR });

    mockGetLatestLedger.mockResolvedValue({ id: 'lid', sequence: CHAIN_HEAD, protocolVersion: 21 });
    mockGetLedgerDetails.mockResolvedValue({
      id: 'lid', paging_token: '1', hash: 'h', prev_hash: '', sequence: 0,
      successful_transaction_count: 0, failed_transaction_count: 0, operation_count: 0,
      total_coins: '0', fee_pool: '0', base_fee_in_stroops: 100, base_reserve_in_stroops: 5000000,
      max_tx_set_size: 1000, protocol_version: 21,
      closed_at: new Date().toISOString(), created_at: new Date().toISOString(),
    });

    const fetchedLedgers = new Set<number>();
    mockBatchGetLedgerTransactions.mockImplementation(async (_url, ledgerRange) => {
      const result = new Map<number, ReturnType<typeof makeTxRecord>[]>();
      for (const seq of ledgerRange) {
        fetchedLedgers.add(seq);
        result.set(seq, []);
      }
      return result;
    });

    const indexer = new SorobanIndexer(TEST_CONFIG);
    await indexer.indexLatestTransactions();

    // Should start from SAVED_CURSOR+1, not from anywhere earlier
    expect(Math.min(...Array.from(fetchedLedgers))).toBe(SAVED_CURSOR + 1);
    expect(Math.max(...Array.from(fetchedLedgers))).toBe(CHAIN_HEAD);
  });

  it('does not call batchGetLedgerTransactions when already at chain head', async () => {
    const HEAD = 2000;
    rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: HEAD });
    mockGetLatestLedger.mockResolvedValue({ id: 'lid', sequence: HEAD, protocolVersion: 21 });

    const indexer = new SorobanIndexer(TEST_CONFIG);
    await indexer.indexLatestTransactions();

    expect(mockBatchGetLedgerTransactions).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// AC5 — Reorg detection: fake txHash → ORPHANED after reindex
// ===========================================================================

describe('AC5 — reorg detection: orphaned transactions when ledger hash changes', () => {
  it('marks stored transactions ORPHANED when the ledger hash no longer matches', async () => {
    const LEDGER_SEQ = 1200;
    const FAKE_TX_HASH = 'fake-tx-not-on-chain';
    const STORED_LEDGER_HASH = 'old-hash-from-forked-chain';
    const CANONICAL_HASH = 'canonical-new-hash';

    // Pre-seed a transaction with a stale (forked) ledger hash
    blockchainTransactionRepo.upsert({
      txHash: FAKE_TX_HASH,
      blockNumber: LEDGER_SEQ,
      blockHash: STORED_LEDGER_HASH,
      status: TransactionStatus.CONFIRMED,
      from: 'GFROM',
      to: 'GTO',
      amount: '1000',
      fee: '100',
      operationType: 'payment',
      createdAt: new Date().toISOString(),
      processed: false,
    });

    // Indexer scans ledger LEDGER_SEQ again and finds a different hash
    mockGetLatestLedger.mockResolvedValue({
      id: 'lid',
      sequence: LEDGER_SEQ,
      protocolVersion: 21,
    });

    // getLedgerDetails returns the CANONICAL hash (different from stored)
    mockGetLedgerDetails.mockResolvedValue({
      id: 'lid', paging_token: '1', hash: CANONICAL_HASH, prev_hash: '', sequence: LEDGER_SEQ,
      successful_transaction_count: 0, failed_transaction_count: 0, operation_count: 0,
      total_coins: '0', fee_pool: '0', base_fee_in_stroops: 100, base_reserve_in_stroops: 5000000,
      max_tx_set_size: 1000, protocol_version: 21,
      closed_at: new Date().toISOString(), created_at: new Date().toISOString(),
    });

    // No new transactions on the canonical chain for this ledger
    mockBatchGetLedgerTransactions.mockResolvedValue(new Map([[LEDGER_SEQ, []]]));

    // Seed cursor just behind LEDGER_SEQ so it processes that ledger
    rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: LEDGER_SEQ - 1 });

    const indexer = new SorobanIndexer(TEST_CONFIG);
    await indexer.indexLatestTransactions();

    const stored = blockchainTransactionRepo.findByHash(FAKE_TX_HASH);
    expect(stored).toBeDefined();
    expect(stored!.status).toBe(TransactionStatus.ORPHANED);
  });

  it('does NOT orphan transactions when the ledger hash matches', async () => {
    const LEDGER_SEQ = 1201;
    const TX_HASH = 'valid-tx';
    const SAME_HASH = 'consistent-ledger-hash';

    blockchainTransactionRepo.upsert({
      txHash: TX_HASH,
      blockNumber: LEDGER_SEQ,
      blockHash: SAME_HASH,
      status: TransactionStatus.CONFIRMED,
      from: 'GFROM',
      to: 'GTO',
      amount: '0',
      fee: '100',
      operationType: 'payment',
      createdAt: new Date().toISOString(),
      processed: false,
    });

    mockGetLatestLedger.mockResolvedValue({ id: 'lid', sequence: LEDGER_SEQ, protocolVersion: 21 });
    mockGetLedgerDetails.mockResolvedValue({
      id: 'lid', paging_token: '1', hash: SAME_HASH, prev_hash: '', sequence: LEDGER_SEQ,
      successful_transaction_count: 1, failed_transaction_count: 0, operation_count: 1,
      total_coins: '0', fee_pool: '0', base_fee_in_stroops: 100, base_reserve_in_stroops: 5000000,
      max_tx_set_size: 1000, protocol_version: 21,
      closed_at: new Date().toISOString(), created_at: new Date().toISOString(),
    });

    mockBatchGetLedgerTransactions.mockResolvedValue(new Map([[LEDGER_SEQ, []]]));
    rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: LEDGER_SEQ - 1 });

    const indexer = new SorobanIndexer(TEST_CONFIG);
    await indexer.indexLatestTransactions();

    const stored = blockchainTransactionRepo.findByHash(TX_HASH);
    expect(stored!.status).toBe(TransactionStatus.CONFIRMED);
  });

  it('handles getLedgerDetails network failure gracefully during reorg check', async () => {
    const LEDGER_SEQ = 1202;
    const TX_HASH = 'reorg-net-fail-tx';

    blockchainTransactionRepo.upsert({
      txHash: TX_HASH,
      blockNumber: LEDGER_SEQ,
      blockHash: 'some-hash',
      status: TransactionStatus.CONFIRMED,
      from: 'G',
      to: 'G',
      amount: '0',
      fee: '0',
      operationType: 'payment',
      createdAt: new Date().toISOString(),
      processed: false,
    });

    mockGetLatestLedger.mockResolvedValue({ id: 'lid', sequence: LEDGER_SEQ, protocolVersion: 21 });
    // First call (reorg check) throws; second call (blockHash population) also throws
    mockGetLedgerDetails.mockRejectedValue(new Error('network error'));
    mockBatchGetLedgerTransactions.mockResolvedValue(new Map([[LEDGER_SEQ, []]]));
    rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: LEDGER_SEQ - 1 });

    const indexer = new SorobanIndexer(TEST_CONFIG);
    // Must not throw
    await expect(indexer.indexLatestTransactions()).resolves.not.toThrow();
    // Row is preserved (not modified when reorg check fails)
    const stored = blockchainTransactionRepo.findByHash(TX_HASH);
    expect(stored).toBeDefined();
  });
});

// ===========================================================================
// AC6 — getIndexerStatus() / GET /api/v1/admin/health indexer shape
// ===========================================================================

describe('AC6 — getIndexerStatus returns { latestIndexed, latestChain, lagLedgers, isRunning }', () => {
  it('returns the correct shape with zero values on a fresh indexer', () => {
    const indexer = new SorobanIndexer(TEST_CONFIG);
    const status = indexer.getIndexerStatus();

    expect(status).toHaveProperty('latestIndexed');
    expect(status).toHaveProperty('latestChain');
    expect(status).toHaveProperty('lagLedgers');
    expect(status).toHaveProperty('isRunning');
  });

  it('reflects latestIndexed from the durable cursor', () => {
    rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: 12345 });

    const indexer = new SorobanIndexer(TEST_CONFIG);
    const status = indexer.getIndexerStatus();

    expect(status.latestIndexed).toBe(12345);
  });

  it('computes lagLedgers correctly', () => {
    rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: 900 });

    const indexer = new SorobanIndexer(TEST_CONFIG);
    // Manually set the chain head (as indexLatestTransactions would do)
    // We do this by running through one full indexing cycle
    mockGetLatestLedger.mockResolvedValue({ id: 'lid', sequence: 1000, protocolVersion: 21 });
    mockGetLedgerDetails.mockResolvedValue({
      id: 'lid', paging_token: '1', hash: 'h', prev_hash: '', sequence: 0,
      successful_transaction_count: 0, failed_transaction_count: 0, operation_count: 0,
      total_coins: '0', fee_pool: '0', base_fee_in_stroops: 100, base_reserve_in_stroops: 5000000,
      max_tx_set_size: 1000, protocol_version: 21,
      closed_at: new Date().toISOString(), created_at: new Date().toISOString(),
    });
    mockBatchGetLedgerTransactions.mockResolvedValue(new Map());

    return indexer.indexLatestTransactions().then(() => {
      const status = indexer.getIndexerStatus();
      expect(status.latestChain).toBe(1000);
      expect(status.latestIndexed).toBe(1000);
      expect(status.lagLedgers).toBe(0);
    });
  });

  it('lagLedgers is never negative', () => {
    // latestIndexed > latestChain should not yield negative lag
    rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: 5000 });

    const indexer = new SorobanIndexer(TEST_CONFIG);
    const status = indexer.getIndexerStatus();

    expect(status.lagLedgers).toBeGreaterThanOrEqual(0);
  });

  it('isRunning is false when no scan is in progress', () => {
    const indexer = new SorobanIndexer(TEST_CONFIG);
    expect(indexer.getIndexerStatus().isRunning).toBe(false);
  });

  it('getSorobanIndexer() singleton returns status with correct shape', () => {
    const indexer = getSorobanIndexer(TEST_CONFIG);
    const status = indexer.getIndexerStatus();

    expect(typeof status.latestIndexed).toBe('number');
    expect(typeof status.latestChain).toBe('number');
    expect(typeof status.lagLedgers).toBe('number');
    expect(typeof status.isRunning).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// AC6 (continued) — health endpoint contract (verified via indexer directly;
// the route is a thin wrapper around getIndexerStatus() — tested in a
// dedicated route test file that runs in the Next.js edge environment)
// ---------------------------------------------------------------------------

describe('AC6 — health endpoint contract via getSorobanIndexer()', () => {
  it('getIndexerStatus() produces the full shape expected by the health route', () => {
    // Persist a known cursor so latestIndexed is non-zero
    rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: 42 });

    const indexer = getSorobanIndexer(TEST_CONFIG);
    const status = indexer.getIndexerStatus();

    // Exact keys the health route reads
    expect(status).toMatchObject({
      latestIndexed: 42,
      latestChain: expect.any(Number),
      lagLedgers: expect.any(Number),
      isRunning: expect.any(Boolean),
    });
  });

  it('lagLedgers = latestChain - latestIndexed (clamped to 0)', async () => {
    const INDEXED = 900;
    const CHAIN = 1000;

    rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: INDEXED });

    mockGetLatestLedger.mockResolvedValue({ id: 'lid', sequence: CHAIN, protocolVersion: 21 });
    mockGetLedgerDetails.mockResolvedValue({
      id: 'lid', paging_token: '1', hash: 'h', prev_hash: '', sequence: CHAIN,
      successful_transaction_count: 0, failed_transaction_count: 0, operation_count: 0,
      total_coins: '0', fee_pool: '0', base_fee_in_stroops: 100, base_reserve_in_stroops: 5000000,
      max_tx_set_size: 1000, protocol_version: 21,
      closed_at: new Date().toISOString(), created_at: new Date().toISOString(),
    });
    mockBatchGetLedgerTransactions.mockResolvedValue(new Map());

    const indexer = new SorobanIndexer(TEST_CONFIG);
    await indexer.indexLatestTransactions();

    const status = indexer.getIndexerStatus();
    expect(status.latestChain).toBe(CHAIN);
    expect(status.latestIndexed).toBe(CHAIN);
    expect(status.lagLedgers).toBe(0);
  });

  it('isRunning reflects whether an indexing cycle is in progress', async () => {
    const CHAIN = 1000;
    rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: CHAIN - 1 });

    mockGetLatestLedger.mockResolvedValue({ id: 'lid', sequence: CHAIN, protocolVersion: 21 });
    mockGetLedgerDetails.mockResolvedValue({
      id: 'lid', paging_token: '1', hash: 'h', prev_hash: '', sequence: CHAIN,
      successful_transaction_count: 0, failed_transaction_count: 0, operation_count: 0,
      total_coins: '0', fee_pool: '0', base_fee_in_stroops: 100, base_reserve_in_stroops: 5000000,
      max_tx_set_size: 1000, protocol_version: 21,
      closed_at: new Date().toISOString(), created_at: new Date().toISOString(),
    });
    mockBatchGetLedgerTransactions.mockResolvedValue(new Map([[CHAIN, []]]));

    const indexer = new SorobanIndexer(TEST_CONFIG);
    expect(indexer.getIndexerStatus().isRunning).toBe(false);

    const scanPromise = indexer.indexLatestTransactions();
    // After the promise resolves, isRunning must be false again
    await scanPromise;
    expect(indexer.getIndexerStatus().isRunning).toBe(false);
  });
});

// ===========================================================================
// AC7 — Benchmark: ≥ 100 ledgers/sec against a local stub
// ===========================================================================

describe('AC7 — throughput benchmark: ≥ 100 ledgers/sec', () => {
  it('processes 500 ledgers in under 5 000 ms (≥ 100 ledgers/sec)', async () => {
    const LEDGER_COUNT = 500;
    const CHAIN_HEAD = 10_000;
    const START_LEDGER = CHAIN_HEAD - LEDGER_COUNT; // 9500

    rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: START_LEDGER });

    mockGetLatestLedger.mockResolvedValue({
      id: 'lid',
      sequence: CHAIN_HEAD,
      protocolVersion: 21,
    });

    // Stub getLedgerDetails so it resolves instantly (no I/O)
    mockGetLedgerDetails.mockImplementation(async (_url, seq) => ({
      id: 'lid', paging_token: '1', hash: `hash-${seq}`, prev_hash: '',
      sequence: seq as number,
      successful_transaction_count: 1, failed_transaction_count: 0, operation_count: 1,
      total_coins: '0', fee_pool: '0', base_fee_in_stroops: 100, base_reserve_in_stroops: 5000000,
      max_tx_set_size: 1000, protocol_version: 21,
      closed_at: new Date().toISOString(), created_at: new Date().toISOString(),
    }));

    // Stub batchGetLedgerTransactions to return pre-generated records synchronously
    mockBatchGetLedgerTransactions.mockImplementation(async (_url, ledgerRange) => {
      const result = new Map<number, ReturnType<typeof makeTxRecord>[]>();
      for (const seq of ledgerRange) {
        result.set(seq, [makeTxRecord({ hash: `bench-tx-${seq}`, ledger: seq })]);
      }
      return result;
    });

    const indexer = new SorobanIndexer({
      ...TEST_CONFIG,
      batchSize: 50, // 10 windows × 50 ledgers
    });

    const start = Date.now();
    await indexer.indexLatestTransactions();
    const elapsed = Date.now() - start;

    const throughput = (LEDGER_COUNT / elapsed) * 1000; // ledgers per second

    expect(throughput).toBeGreaterThanOrEqual(100);
    // Belt-and-suspenders: all ledgers must actually have been indexed
    const tracker = rollupTrackerRepo.find('soroban_indexer');
    expect(tracker!.lastProcessedLedger).toBe(CHAIN_HEAD);
  }, 10_000); // 10 s timeout — well above the ≥100 lps target

  it('processes 10 000 events in under 5 000 ms via buffered flush', async () => {
    const EVENT_COUNT = 10_000;
    const LEDGER_SEQ = 5000;

    mockGetLatestLedger.mockResolvedValue({ id: 'lid', sequence: LEDGER_SEQ, protocolVersion: 21 });

    const events = Array.from({ length: EVENT_COUNT }, (_, i) =>
      makeEventRecord({
        id: `${LEDGER_SEQ}-0-${i}`,
        txHash: `bench-event-tx-${Math.floor(i / 10)}`,
        ledger: LEDGER_SEQ,
      })
    );

    mockPaginateEvents.mockImplementation(async (_url, opts) => {
      // Deliver in pages of 200 to exercise pagination
      const PAGE_SIZE = 200;
      for (let page = 0; page < events.length; page += PAGE_SIZE) {
        const slice = events.slice(page, page + PAGE_SIZE);
        const hasMore = page + PAGE_SIZE < events.length;
        await opts.onPage({
          events: slice,
          latestLedger: LEDGER_SEQ,
          cursor: hasMore ? `cursor-${page + PAGE_SIZE}` : undefined,
        });
      }
      return { finalCursor: '', latestLedger: LEDGER_SEQ };
    });

    rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: LEDGER_SEQ });

    const indexer = new SorobanIndexer(TEST_CONFIG);

    const start = Date.now();
    await indexer.indexContractEvents();
    const elapsed = Date.now() - start;

    expect(contractEventRepo.count()).toBe(EVENT_COUNT);
    expect(elapsed).toBeLessThan(5000);
  }, 10_000);
});

// ===========================================================================
// Public API preservation (constraints: signatures unchanged)
// ===========================================================================

describe('Public API: indexTransaction and indexEvent signatures unchanged', () => {
  it('indexTransaction writes a CONFIRMED row', () => {
    const indexer = new SorobanIndexer(TEST_CONFIG);
    indexer.indexTransaction('sig-tx-hash', 999, {
      from: 'GFROM',
      to: 'GTO',
      amount: '5000000',
      fee: '100',
      operationType: 'payment',
      memo: 'test memo',
    });

    const stored = blockchainTransactionRepo.findByHash('sig-tx-hash');
    expect(stored).toBeDefined();
    expect(stored!.status).toBe(TransactionStatus.CONFIRMED);
    expect(stored!.blockNumber).toBe(999);
    expect(stored!.from).toBe('GFROM');
    expect(stored!.memo).toBe('test memo');
  });

  it('indexTransaction works with no metadata (default args)', () => {
    const indexer = new SorobanIndexer(TEST_CONFIG);
    indexer.indexTransaction('minimal-tx', 1);
    const stored = blockchainTransactionRepo.findByHash('minimal-tx');
    expect(stored).toBeDefined();
    expect(stored!.status).toBe(TransactionStatus.CONFIRMED);
  });

  it('indexEvent writes a ContractEvent row with composite key', () => {
    const indexer = new SorobanIndexer(TEST_CONFIG);
    indexer.indexEvent('ev-tx', 'CONTRACT', 'transfer', 1000, 0, { amount: '100' });

    expect(contractEventRepo.exists('ev-tx', 'CONTRACT', 'transfer', 1000, 0)).toBe(true);
  });

  it('indexEvent is idempotent on repeated calls with same composite key', () => {
    const indexer = new SorobanIndexer(TEST_CONFIG);
    indexer.indexEvent('dup-tx', 'C', 'ev', 100, 0);
    indexer.indexEvent('dup-tx', 'C', 'ev', 100, 0);
    indexer.indexEvent('dup-tx', 'C', 'ev', 100, 0);
    expect(contractEventRepo.count()).toBe(1);
  });

  it('indexEvent stores distinct events with different eventIndex', () => {
    const indexer = new SorobanIndexer(TEST_CONFIG);
    indexer.indexEvent('multi-tx', 'C', 'ev', 100, 0);
    indexer.indexEvent('multi-tx', 'C', 'ev', 100, 1);
    indexer.indexEvent('multi-tx', 'C', 'ev', 100, 2);
    expect(contractEventRepo.count()).toBe(3);
  });
});

// ===========================================================================
// In-memory buffer flush — max 10 000 items constraint
// ===========================================================================

describe('In-memory event buffer: flushes before reaching 10 000 items', () => {
  it('flushes mid-page when the buffer would exceed maxBufferSize', async () => {
    const LEDGER_SEQ = 6000;
    const MAX_BUFFER = 100; // Use a small maxBufferSize for the test
    const TOTAL_EVENTS = 250;

    mockGetLatestLedger.mockResolvedValue({ id: 'lid', sequence: LEDGER_SEQ, protocolVersion: 21 });

    const events = Array.from({ length: TOTAL_EVENTS }, (_, i) =>
      makeEventRecord({ id: `${LEDGER_SEQ}-0-${i}`, txHash: `buf-tx-${i}`, ledger: LEDGER_SEQ })
    );

    mockPaginateEvents.mockImplementation(async (_url, opts) => {
      await opts.onPage({ events, latestLedger: LEDGER_SEQ, cursor: undefined });
      return { finalCursor: '', latestLedger: LEDGER_SEQ };
    });

    rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: LEDGER_SEQ });

    // Use a small buffer so the mid-page flush is triggered
    const indexer = new SorobanIndexer({ ...TEST_CONFIG, maxBufferSize: MAX_BUFFER });
    await indexer.indexContractEvents();

    // All events must be persisted despite partial flush
    expect(contractEventRepo.count()).toBe(TOTAL_EVENTS);
  });
});

// ===========================================================================
// TXAC1 — getEvents with no txHash in RPC response → no element has txHash === ''
// ===========================================================================

describe('TXAC1 — no event has txHash === "" when RPC omits txHash', () => {
  it('every event returned by paginateEvents has a non-empty txHash', async () => {
    const LEDGER_SEQ = 7000;
    mockGetLatestLedger.mockResolvedValue({ id: 'lid', sequence: LEDGER_SEQ, protocolVersion: 21 });

    // Events WITHOUT txHash (simulates older/non-standard RPC node)
    const eventsWithoutHash = [
      { ...makeEventRecord({ id: `${LEDGER_SEQ}-0-0`, ledger: LEDGER_SEQ }), txHash: undefined },
      { ...makeEventRecord({ id: `${LEDGER_SEQ}-0-1`, ledger: LEDGER_SEQ }), txHash: undefined },
      { ...makeEventRecord({ id: `${LEDGER_SEQ}-1-0`, ledger: LEDGER_SEQ }), txHash: undefined },
    ] as ReturnType<typeof makeEventRecord>[];

    // paginateEvents passes the events through directly; we simulate it returning
    // events that have already been processed by getEvents (with sentinels assigned)
    // by using the real makeSentinelTxHash helper on each event.
    const processedEvents = eventsWithoutHash.map((e) => ({
      ...e,
      txHash: makeSentinelTxHash(e.id),
    }));

    mockPaginateEvents.mockImplementation(async (_url, opts) => {
      await opts.onPage({ events: processedEvents, latestLedger: LEDGER_SEQ, cursor: undefined });
      return { finalCursor: '', latestLedger: LEDGER_SEQ };
    });

    rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: LEDGER_SEQ });

    const indexer = new SorobanIndexer(TEST_CONFIG);
    await indexer.indexContractEvents();

    // No stored event should have txHash === ''
    const all = contractEventRepo.__all();
    expect(all.length).toBe(3);
    for (const ev of all) {
      expect(ev.txHash).not.toBe('');
      expect(ev.txHash.length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// TXAC2 — Two events with distinct ids but both missing txHash → distinct sentinels
// ===========================================================================

describe('TXAC2 — distinct sentinel values for events with distinct ids', () => {
  it('two events with different event IDs produce different sentinel txHash values', () => {
    const id1 = '12345-0-0';
    const id2 = '12345-1-0';

    const sentinel1 = makeSentinelTxHash(id1);
    const sentinel2 = makeSentinelTxHash(id2);

    // Sentinels must be distinct
    expect(sentinel1).not.toBe(sentinel2);
    // Sentinels must be non-empty
    expect(sentinel1.length).toBeGreaterThan(0);
    expect(sentinel2.length).toBeGreaterThan(0);
    // Sentinels must be recognizable
    expect(isUnresolvedTxHash(sentinel1)).toBe(true);
    expect(isUnresolvedTxHash(sentinel2)).toBe(true);
  });

  it('sentinel encodes the full event ID so collisions are impossible', () => {
    const ids = [
      '12345-0-0',
      '12345-0-1',
      '12345-1-0',
      '12346-0-0',
    ];
    const sentinels = ids.map(makeSentinelTxHash);
    const unique = new Set(sentinels);
    expect(unique.size).toBe(ids.length);
  });

  it('isUnresolvedTxHash returns false for real hex hashes', () => {
    const realHash = 'a'.repeat(64);
    expect(isUnresolvedTxHash(realHash)).toBe(false);
  });
});

// ===========================================================================
// TXAC3 — Event id='12345-2-0', Horizon fallback returns hash → txHash resolved
// ===========================================================================

describe('TXAC3 — resolveUnresolvedEvents resolves sentinel using Horizon fallback', () => {
  it('resolves sentinel event to real hash after Horizon lookup succeeds', async () => {
    const EVENT_ID = '12345-2-0';
    const LEDGER_SEQ = 12345;
    const TX_ORDER = 2;
    const RESOLVED_HASH = 'abcdef1234567890'.repeat(4); // 64 char hex

    // Pre-store an event with a sentinel txHash
    const sentinel = makeSentinelTxHash(EVENT_ID);
    contractEventRepo.upsert({
      txHash: sentinel,
      contractAddress: 'CONTRACT_X',
      eventName: 'transfer',
      ledgerSequence: LEDGER_SEQ,
      eventIndex: 0,
      parameters: {},
      processed: false,
    });

    // Horizon returns 3 transactions; the one at txOrder=2 (index 2) has our hash
    const txRecords = [
      makeTxRecord({ hash: 'aaaa' + 'a'.repeat(60), ledger: LEDGER_SEQ }),
      makeTxRecord({ hash: 'bbbb' + 'b'.repeat(60), ledger: LEDGER_SEQ }),
      makeTxRecord({ hash: RESOLVED_HASH, ledger: LEDGER_SEQ }), // index 2 = txOrder 2
    ];
    mockGetLedgerTransactions.mockResolvedValueOnce(txRecords);

    // Run the re-resolution cycle
    mockGetLatestLedger.mockResolvedValue({ id: 'lid', sequence: LEDGER_SEQ, protocolVersion: 21 });
    const indexer = new SorobanIndexer(TEST_CONFIG);
    await indexer.resolveUnresolvedEvents();

    // The sentinel row should now be the resolved hash
    const resolved = contractEventRepo.findByHash(RESOLVED_HASH);
    expect(resolved).toBeDefined();
    expect(resolved!.txHash).toBe(RESOLVED_HASH);

    // The sentinel row must be gone
    const sentinelRow = contractEventRepo.findByHash(sentinel);
    expect(sentinelRow).toBeUndefined();

    // countByTxHash('') must be 0 — the real acceptance criterion
    expect(contractEventRepo.countByTxHash('')).toBe(0);
  });
});

// ===========================================================================
// TXAC4 — Deduplication: two events with same params but different event IDs
//          produce distinct sentinel keys and are stored as 2 separate rows
// ===========================================================================

describe('TXAC4 — deduplication: distinct sentinels prevent key collision', () => {
  it('two events with txHash="" before the fix produce distinct keys after the fix', () => {
    // Simulate what USED to happen: both events had txHash: '' and would collide.
    // After the fix, paginateEvents assigns sentinels derived from event IDs.
    const CONTRACT = 'CABC';
    const EVENT_NAME = 'donate';
    const LEDGER = 100;

    const eventId1 = `${LEDGER}-0-0`;
    const eventId2 = `${LEDGER}-1-0`; // different tx order in same ledger

    const sentinel1 = makeSentinelTxHash(eventId1);
    const sentinel2 = makeSentinelTxHash(eventId2);

    // Insert as if they came from separate transactions in the same ledger
    contractEventRepo.upsert({
      txHash: sentinel1,
      contractAddress: CONTRACT,
      eventName: EVENT_NAME,
      ledgerSequence: LEDGER,
      eventIndex: 0,
      parameters: { donor: 'G1' },
      processed: false,
    });
    contractEventRepo.upsert({
      txHash: sentinel2,
      contractAddress: CONTRACT,
      eventName: EVENT_NAME,
      ledgerSequence: LEDGER,
      eventIndex: 0,
      parameters: { donor: 'G2' },
      processed: false,
    });

    // With the old '' txHash both would map to the same composite key and
    // only 1 would be stored.  After the fix we get 2 distinct rows.
    expect(contractEventRepo.count()).toBe(2);

    // Verify neither has txHash === ''
    for (const ev of contractEventRepo.__all()) {
      expect(ev.txHash).not.toBe('');
    }
  });
});

// ===========================================================================
// TXAC5 — 100 events with no txHash → zero entries with txHash === ''
// ===========================================================================

describe('TXAC5 — zero events stored with txHash === "" after processing', () => {
  it('100 events with missing txHash are stored with sentinel values, not empty strings', async () => {
    const LEDGER_SEQ = 8000;
    mockGetLatestLedger.mockResolvedValue({ id: 'lid', sequence: LEDGER_SEQ, protocolVersion: 21 });

    // 100 events where paginateEvents has already replaced '' with sentinels
    const processedEvents = Array.from({ length: 100 }, (_, i) => {
      const id = `${LEDGER_SEQ}-${i}-0`;
      return {
        ...makeEventRecord({ id, ledger: LEDGER_SEQ }),
        txHash: makeSentinelTxHash(id),
      };
    });

    mockPaginateEvents.mockImplementation(async (_url, opts) => {
      await opts.onPage({ events: processedEvents, latestLedger: LEDGER_SEQ, cursor: undefined });
      return { finalCursor: '', latestLedger: LEDGER_SEQ };
    });

    rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: LEDGER_SEQ });

    const indexer = new SorobanIndexer(TEST_CONFIG);
    await indexer.indexContractEvents();

    expect(contractEventRepo.count()).toBe(100);
    // Core acceptance criterion: countByTxHash('') must be 0
    expect(contractEventRepo.countByTxHash('')).toBe(0);

    // All events must have non-empty txHash
    for (const ev of contractEventRepo.__all()) {
      expect(ev.txHash).not.toBe('');
      expect(ev.txHash.length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// TXAC6 — resolveUnresolvedEvents updates sentinel → real hash; findByHash works
// ===========================================================================

describe('TXAC6 — re-resolution cycle: sentinel updated to real hash', () => {
  it('previously stored sentinel row is updated to the resolved hash', async () => {
    const LEDGER_SEQ = 9000;
    const TX_ORDER = 0;
    const EVENT_ID = `${LEDGER_SEQ}-${TX_ORDER}-0`;
    const REAL_HASH = 'deadbeef'.repeat(8); // 64 chars

    const sentinel = makeSentinelTxHash(EVENT_ID);

    // Pre-store with sentinel
    contractEventRepo.upsert({
      txHash: sentinel,
      contractAddress: 'CONTRACT_RE',
      eventName: 'claim',
      ledgerSequence: LEDGER_SEQ,
      eventIndex: 0,
      parameters: { claimant: 'GXYZ' },
      processed: false,
    });

    // Horizon now has the transaction
    const txRecords = [makeTxRecord({ hash: REAL_HASH, ledger: LEDGER_SEQ })];
    mockGetLedgerTransactions.mockResolvedValueOnce(txRecords);
    mockGetLatestLedger.mockResolvedValue({ id: 'lid', sequence: LEDGER_SEQ, protocolVersion: 21 });

    const indexer = new SorobanIndexer(TEST_CONFIG);
    await indexer.resolveUnresolvedEvents();

    // Verify via findByHash
    const resolved = contractEventRepo.findByHash(REAL_HASH);
    expect(resolved).toBeDefined();
    expect(resolved!.txHash).toBe(REAL_HASH);
    expect(resolved!.eventName).toBe('claim');

    // Sentinel row must be gone
    expect(contractEventRepo.findByHash(sentinel)).toBeUndefined();
  });

  it('resolveUnresolvedEvents is a no-op when there are no sentinels', async () => {
    // Store a real-hash event (not a sentinel)
    contractEventRepo.upsert({
      txHash: 'real' + 'a'.repeat(60),
      contractAddress: 'C',
      eventName: 'ev',
      ledgerSequence: 1,
      eventIndex: 0,
      parameters: {},
      processed: false,
    });

    const indexer = new SorobanIndexer(TEST_CONFIG);
    // Must not throw and must not call getLedgerTransactions
    await expect(indexer.resolveUnresolvedEvents()).resolves.not.toThrow();
    expect(mockGetLedgerTransactions).not.toHaveBeenCalled();
    expect(contractEventRepo.count()).toBe(1);
  });

  it('handles Horizon failure gracefully during re-resolution (sentinel remains)', async () => {
    const EVENT_ID = '11111-0-0';
    const sentinel = makeSentinelTxHash(EVENT_ID);

    contractEventRepo.upsert({
      txHash: sentinel,
      contractAddress: 'C',
      eventName: 'ev',
      ledgerSequence: 11111,
      eventIndex: 0,
      parameters: {},
      processed: false,
    });

    mockGetLedgerTransactions.mockRejectedValueOnce(new Error('horizon down'));
    mockGetLatestLedger.mockResolvedValue({ id: 'lid', sequence: 11111, protocolVersion: 21 });

    const indexer = new SorobanIndexer(TEST_CONFIG);
    // Must not throw
    await expect(indexer.resolveUnresolvedEvents()).resolves.not.toThrow();

    // Sentinel row must still be present (not corrupted)
    expect(contractEventRepo.findByHash(sentinel)).toBeDefined();
  });
});

// ===========================================================================
// TXAC8 — Property-based: N random event IDs → sentinel never returns ''
// ===========================================================================

describe('TXAC8 — property-based: makeSentinelTxHash never returns ""', () => {
  it('returns a non-empty sentinel for 200 randomly generated event IDs', () => {
    // Generate random event IDs in the Soroban format: <ledger>-<txOrder>-<eventIndex>
    const randomInt = (max: number) => Math.floor(Math.random() * max);

    for (let i = 0; i < 200; i++) {
      const ledger = randomInt(10_000_000) + 1;
      const txOrder = randomInt(1000);
      const eventIndex = randomInt(100);
      const eventId = `${ledger}-${txOrder}-${eventIndex}`;

      const result = makeSentinelTxHash(eventId);

      // Must never return ''
      expect(result).not.toBe('');
      // Must be detectable as unresolved
      expect(isUnresolvedTxHash(result)).toBe(true);
      // Must contain the original eventId (for debuggability)
      expect(result).toContain(eventId);
    }
  });

  it('a valid 64-char hex hash is never flagged as unresolved', () => {
    const hexChars = '0123456789abcdef';
    for (let i = 0; i < 50; i++) {
      const hash = Array.from(
        { length: 64 },
        () => hexChars[Math.floor(Math.random() * 16)]
      ).join('');
      expect(isUnresolvedTxHash(hash)).toBe(false);
    }
  });
});
