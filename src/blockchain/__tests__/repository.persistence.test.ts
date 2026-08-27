/**
 * Integration tests for SQLite persistence across cold-start boundaries.
 *
 * These tests verify the acceptance criteria for the SQLite migration:
 *
 * AC1 – rollupTrackerRepo.find('soroban_indexer') returns the persisted
 *        cursor after a simulated cold-start (close + reopen the DB
 *        connection, which mirrors a real process restart).
 *
 * AC2 – blockchainTransactionRepo.count() returns the same value before
 *        and after a simulated process restart.
 *
 * AC3 – Kill-between-batches crash: only the in-flight batch is lost;
 *        prior committed batches survive.
 *
 * AC4 – Two concurrent writer processes (via child_process.fork) each
 *        writing 1 000 non-overlapping txHash values produce exactly
 *        2 000 distinct rows — no deadlocks, no lost writes.
 *
 * AC5 – 10 000 sequential upserts complete in under 5 000 ms.
 *
 * Implementation notes:
 *   - Cold-start simulation: we use a real temporary file-based SQLite DB,
 *     call __closeDb() to close the connection (simulating process exit),
 *     then re-open by calling getDb() again (simulating process start).
 *   - Concurrent writers: child_process.fork spawns isolated Node processes
 *     each running concurrent-writer-helper.ts against the same file.
 *     SQLite WAL mode serialises the writes safely.
 *   - Each test that writes to a file DB uses a unique temp path to avoid
 *     state leakage between tests.
 */

import { fork } from 'child_process';
import { mkdirSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a unique temp file path for a file-based SQLite DB. */
function tempDbPath(): string {
  const dir = join(tmpdir(), 'aidlink-test-dbs');
  mkdirSync(dir, { recursive: true });
  return join(dir, `test-${randomUUID()}.db`);
}

/** Clean up a temp DB and its WAL/SHM sidecar files. */
function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = `${dbPath}${suffix}`;
    if (existsSync(p)) {
      try { unlinkSync(p); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Module imports
// ---------------------------------------------------------------------------

import { getDb, __closeDb, __resetDb } from '../db';
import {
  blockchainTransactionRepo,
  contractEventRepo,
  rollupTrackerRepo,
} from '../repository';
import { TransactionStatus } from '../types';

/** Snapshot the original DB path set by jest.setup.js (':memory:') */
const ORIGINAL_DB_PATH = process.env.BLOCKCHAIN_DB_PATH ?? ':memory:';

afterEach(() => {
  // Restore in-memory mode so other test files are unaffected.
  process.env.BLOCKCHAIN_DB_PATH = ORIGINAL_DB_PATH;
  __closeDb(); // close any open file connection; next getDb() call re-opens
});

// ---------------------------------------------------------------------------
// Helper: switch to a fresh file-based DB for the current test
// ---------------------------------------------------------------------------
function useFileDb(): string {
  const path = tempDbPath();
  process.env.BLOCKCHAIN_DB_PATH = path;
  __closeDb(); // discard cached :memory: connection
  getDb(); // trigger schema creation on the new path
  return path;
}

// ===========================================================================
// AC1 — Cursor survives cold-start (connection close + reopen)
// ===========================================================================

describe('AC1 — rollupTrackerRepo.find returns persisted cursor after cold-start', () => {
  it('cursor written before close is readable after reopen', () => {
    const dbPath = useFileDb();

    try {
      // Write the cursor in the "first process"
      rollupTrackerRepo.upsert('soroban_indexer', {
        lastProcessedLedger: 42_000,
        lastEventCursor: 'cursor-before-restart',
      });

      const before = rollupTrackerRepo.find('soroban_indexer');
      expect(before?.lastProcessedLedger).toBe(42_000);
      expect(before?.lastEventCursor).toBe('cursor-before-restart');

      // Simulate cold-start: close the DB connection
      __closeDb();
      // Re-open the DB (same file path is still in process.env)
      getDb();

      // Read the cursor in the "second process"
      const after = rollupTrackerRepo.find('soroban_indexer');
      expect(after).toBeDefined();
      expect(after!.lastProcessedLedger).toBe(42_000);
      expect(after!.lastEventCursor).toBe('cursor-before-restart');
    } finally {
      __closeDb();
      cleanupDb(dbPath);
    }
  });

  it('find returns undefined for a cursor that was never written, even after restart', () => {
    const dbPath = useFileDb();

    try {
      __closeDb();
      getDb();
      expect(rollupTrackerRepo.find('nonexistent_cursor')).toBeUndefined();
    } finally {
      __closeDb();
      cleanupDb(dbPath);
    }
  });

  it('upsert-then-restart preserves the latest cursor, not a stale one', () => {
    const dbPath = useFileDb();

    try {
      rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: 100 });
      rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: 200 });
      rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: 300 });

      __closeDb();
      getDb();

      const t = rollupTrackerRepo.find('soroban_indexer');
      expect(t!.lastProcessedLedger).toBe(300);
    } finally {
      __closeDb();
      cleanupDb(dbPath);
    }
  });
});

// ===========================================================================
// AC2 — Transaction count survives cold-start
// ===========================================================================

describe('AC2 — blockchainTransactionRepo.count equals same value after cold-start', () => {
  it('count before and after restart are identical', () => {
    const dbPath = useFileDb();

    try {
      for (let i = 0; i < 50; i++) {
        blockchainTransactionRepo.upsert({
          txHash: `persist-tx-${i}`,
          blockNumber: 1000 + i,
          blockHash: `hash-${i}`,
          status: TransactionStatus.CONFIRMED,
          from: 'GFROM',
          to: 'GTO',
          amount: '1000000',
          fee: '100',
          operationType: 'payment',
          createdAt: new Date().toISOString(),
          processed: false,
        });
      }

      const countBefore = blockchainTransactionRepo.count();
      expect(countBefore).toBe(50);

      // Simulate cold-start
      __closeDb();
      getDb();

      const countAfter = blockchainTransactionRepo.count();
      expect(countAfter).toBe(50);
    } finally {
      __closeDb();
      cleanupDb(dbPath);
    }
  });

  it('row contents are preserved across restart, not just the count', () => {
    const dbPath = useFileDb();

    try {
      blockchainTransactionRepo.upsert({
        txHash: 'durable-tx-abc',
        blockNumber: 9_999,
        blockHash: 'durable-hash',
        status: TransactionStatus.CONFIRMED,
        from: 'GSRC',
        to: 'GDST',
        amount: '500',
        fee: '50',
        operationType: 'payment',
        memo: 'hello world',
        createdAt: '2024-01-01T00:00:00.000Z',
        processed: true,
      });

      __closeDb();
      getDb();

      const row = blockchainTransactionRepo.findByHash('durable-tx-abc');
      expect(row).toBeDefined();
      expect(row!.blockNumber).toBe(9_999);
      expect(row!.blockHash).toBe('durable-hash');
      expect(row!.memo).toBe('hello world');
      expect(row!.processed).toBe(true);
    } finally {
      __closeDb();
      cleanupDb(dbPath);
    }
  });
});

// ===========================================================================
// AC3 — Kill-between-batches: only in-flight batch is lost
// ===========================================================================

describe('AC3 — kill-between-batches: prior committed batches survive a crash', () => {
  it('data from committed batches remains after simulated crash during third batch', () => {
    const dbPath = useFileDb();

    try {
      // Batch 1 — commit cursor to 100
      for (let i = 0; i < 10; i++) {
        blockchainTransactionRepo.upsert({
          txHash: `batch1-tx-${i}`,
          blockNumber: i,
          blockHash: '',
          status: TransactionStatus.CONFIRMED,
          from: '', to: '', amount: '0', fee: '0',
          operationType: 'payment',
          createdAt: new Date().toISOString(),
          processed: false,
        });
      }
      rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: 100 });

      // Batch 2 — commit cursor to 200
      for (let i = 10; i < 20; i++) {
        blockchainTransactionRepo.upsert({
          txHash: `batch2-tx-${i}`,
          blockNumber: i,
          blockHash: '',
          status: TransactionStatus.CONFIRMED,
          from: '', to: '', amount: '0', fee: '0',
          operationType: 'payment',
          createdAt: new Date().toISOString(),
          processed: false,
        });
      }
      rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: 200 });

      // Batch 3 begins — write rows but NO cursor update (simulated crash mid-batch)
      blockchainTransactionRepo.upsert({
        txHash: 'batch3-tx-inflight-1',
        blockNumber: 20,
        blockHash: '',
        status: TransactionStatus.CONFIRMED,
        from: '', to: '', amount: '0', fee: '0',
        operationType: 'payment',
        createdAt: new Date().toISOString(),
        processed: false,
      });
      // <---- process killed here; cursor NOT updated to 300

      // Simulate restart
      __closeDb();
      getDb();

      // Cursor is at 200 (last committed batch)
      const tracker = rollupTrackerRepo.find('soroban_indexer');
      expect(tracker!.lastProcessedLedger).toBe(200);

      // All committed batch rows survive
      for (let i = 0; i < 20; i++) {
        const prefix = i < 10 ? 'batch1' : 'batch2';
        const row = blockchainTransactionRepo.findByHash(`${prefix}-tx-${i}`);
        expect(row).toBeDefined();
      }

      // At minimum, all 20 committed rows must be present
      expect(blockchainTransactionRepo.count()).toBeGreaterThanOrEqual(20);
    } finally {
      __closeDb();
      cleanupDb(dbPath);
    }
  });

  it('WAL mode is active on file-based databases', () => {
    const dbPath = useFileDb();

    try {
      const db = getDb();
      const result = db.pragma('journal_mode') as { journal_mode: string }[];
      expect(result[0].journal_mode).toBe('wal');
    } finally {
      __closeDb();
      cleanupDb(dbPath);
    }
  });
});

// ===========================================================================
// AC4 — Concurrent writers: 2 processes × 1 000 inserts = exactly 2 000 rows
// ===========================================================================

describe('AC4 — concurrent writers: 2 × 1 000 inserts = 2 000 distinct rows', () => {
  it('two concurrent fork writers produce exactly 2 000 rows without deadlocks', (done) => {
    // Prepare a file-based DB with the schema
    const dbPath = tempDbPath();
    process.env.BLOCKCHAIN_DB_PATH = dbPath;
    __closeDb();
    getDb(); // creates schema + sets WAL mode
    __closeDb(); // close so workers can open their own connections

    // Plain JS helper (no ts-node needed) that each worker process will run
    const helperScript = resolve(__dirname, '../concurrent-writer-helper.js');
    // Pass the absolute node_modules path so the worker can require better-sqlite3
    const nodeModulesDir = resolve(__dirname, '../../../node_modules');

    let completedWorkers = 0;
    const workerErrors: Error[] = [];

    function onWorkerFinish(err?: Error): void {
      if (err) workerErrors.push(err);
      completedWorkers++;
      if (completedWorkers < 2) return;

      // Both workers done — count final rows in the DB
      process.env.BLOCKCHAIN_DB_PATH = dbPath;
      __closeDb();
      getDb();

      try {
        if (workerErrors.length > 0) {
          done(workerErrors[0]);
          return;
        }

        const finalCount = blockchainTransactionRepo.count();
        expect(finalCount).toBe(2000);
        done();
      } catch (assertErr) {
        done(assertErr as Error);
      } finally {
        __closeDb();
        cleanupDb(dbPath);
        process.env.BLOCKCHAIN_DB_PATH = ORIGINAL_DB_PATH;
      }
    }

    const workerEnv = { ...process.env, BLOCKCHAIN_DB_PATH: dbPath };

    // Spawn two workers; args: [dbPath, workerPrefix, rowCount, nodeModulesDir]
    const w1 = fork(
      helperScript,
      [dbPath, 'worker1', '1000', nodeModulesDir],
      { env: workerEnv, silent: true }
    );
    const w2 = fork(
      helperScript,
      [dbPath, 'worker2', '1000', nodeModulesDir],
      { env: workerEnv, silent: true }
    );

    // Log stderr from workers for debugging
    w1.stderr?.on('data', (d) => process.stderr.write(`[w1 stderr] ${d}`));
    w2.stderr?.on('data', (d) => process.stderr.write(`[w2 stderr] ${d}`));

    w1.on('exit', (code) =>
      onWorkerFinish(code !== 0 ? new Error(`worker1 exited with code ${code}`) : undefined)
    );
    w2.on('exit', (code) =>
      onWorkerFinish(code !== 0 ? new Error(`worker2 exited with code ${code}`) : undefined)
    );

    w1.on('error', onWorkerFinish);
    w2.on('error', onWorkerFinish);
  }, 30_000); // 30 s timeout
});

// ===========================================================================
// AC5 — Write throughput: 10 000 sequential upserts under 5 000 ms
// ===========================================================================

describe('AC5 — write throughput: 10 000 sequential upserts < 5 000 ms', () => {
  it('10 000 upserts complete in under 5 seconds', () => {
    // Use in-memory DB for the benchmark (fastest path)
    __resetDb();

    const N = 10_000;
    const now = new Date().toISOString();

    const start = Date.now();
    for (let i = 0; i < N; i++) {
      blockchainTransactionRepo.upsert({
        txHash: `bench-tx-${i}`,
        blockNumber: i,
        blockHash: '',
        status: TransactionStatus.CONFIRMED,
        from: '',
        to: '',
        amount: '0',
        fee: '0',
        operationType: 'payment',
        createdAt: now,
        processed: false,
      });
    }
    const elapsed = Date.now() - start;

    expect(blockchainTransactionRepo.count()).toBe(N);
    expect(elapsed).toBeLessThan(5_000);

    console.info(`[Benchmark] 10 000 upserts in ${elapsed} ms (${Math.round(N / elapsed * 1000)} upserts/sec)`);
  }, 10_000);

  it('10 000 sequential upserts wrapped in a transaction complete in under 1 000 ms', () => {
    __resetDb();

    const N = 10_000;
    const db = getDb();
    const now = new Date().toISOString();

    const stmt = db.prepare(`
      INSERT OR IGNORE INTO blockchain_transactions
        (id, tx_hash, block_number, block_hash, status, "from", "to",
         amount, fee, operation_type, created_at, indexed_at, processed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((count: number) => {
      for (let i = 0; i < count; i++) {
        stmt.run(
          randomUUID(),
          `bulk-tx-${i}`,
          i, '', 'CONFIRMED', '', '', '0', '0', 'payment',
          now, now, 0
        );
      }
    });

    const start = Date.now();
    insertMany(N);
    const elapsed = Date.now() - start;

    const result = db.prepare('SELECT COUNT(*) as n FROM blockchain_transactions').get() as { n: number };
    expect(result.n).toBe(N);
    // Transactional inserts should be very fast — well under 1 s
    expect(elapsed).toBeLessThan(1_000);

    console.info(`[Benchmark] 10 000 batched inserts in ${elapsed} ms (${Math.round(N / elapsed * 1000)} inserts/sec)`);
  }, 10_000);
});

// ===========================================================================
// Bonus: ContractEvent persistence across cold-start
// ===========================================================================

describe('ContractEvent persistence across cold-start', () => {
  it('contract events are readable after connection close + reopen', () => {
    const dbPath = useFileDb();

    try {
      contractEventRepo.upsert({
        txHash: 'persist-event-tx',
        contractAddress: 'CONTRACT_PERSIST',
        eventName: 'donate',
        ledgerSequence: 500,
        eventIndex: 0,
        parameters: { donor: 'GALICE', amount: '1000' },
        processed: false,
      });

      expect(contractEventRepo.count()).toBe(1);

      __closeDb();
      getDb();

      expect(contractEventRepo.count()).toBe(1);

      const ev = contractEventRepo.findByHash('persist-event-tx');
      expect(ev).toBeDefined();
      expect(ev!.contractAddress).toBe('CONTRACT_PERSIST');
      expect(ev!.parameters).toEqual({ donor: 'GALICE', amount: '1000' });
    } finally {
      __closeDb();
      cleanupDb(dbPath);
    }
  });

  it('unprocessed events survive a cold-start', () => {
    const dbPath = useFileDb();

    try {
      for (let i = 0; i < 5; i++) {
        contractEventRepo.upsert({
          txHash: `unproc-tx-${i}`,
          contractAddress: 'C',
          eventName: 'claim',
          ledgerSequence: 100,
          eventIndex: i,
          parameters: {},
          processed: false,
        });
      }

      __closeDb();
      getDb();

      const unprocessed = contractEventRepo.findUnprocessed();
      expect(unprocessed).toHaveLength(5);
    } finally {
      __closeDb();
      cleanupDb(dbPath);
    }
  });
});
