/**
 * Unit tests for src/blockchain/repository.ts
 *
 * Covers:
 *   - blockchainTransactionRepo: upsert, findByHash, findByLedger,
 *     findFirstByBlockNumberDesc, orphanByLedger, updateStatus
 *   - contractEventRepo: composite-key deduplication, idempotent upsert,
 *     countByTxHash, findUnprocessed
 *   - rollupTrackerRepo: find, upsert, findOrCreate cursor semantics
 *   - __clearAllStores: isolation helper
 */

import {
  blockchainTransactionRepo,
  contractEventRepo,
  rollupTrackerRepo,
  eventCompositeKey,
  __clearAllStores,
} from '../repository';
import { TransactionStatus } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTx(overrides: Partial<Parameters<typeof blockchainTransactionRepo.upsert>[0]> = {}) {
  return blockchainTransactionRepo.upsert({
    txHash: overrides.txHash ?? `hash-${Math.random().toString(36).slice(2)}`,
    blockNumber: overrides.blockNumber ?? 1000,
    blockHash: overrides.blockHash ?? 'abc123',
    status: overrides.status ?? TransactionStatus.CONFIRMED,
    from: overrides.from ?? 'GFROM',
    to: overrides.to ?? 'GTO',
    amount: overrides.amount ?? '1000000',
    fee: overrides.fee ?? '100',
    operationType: overrides.operationType ?? 'payment',
    memo: overrides.memo,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    processed: overrides.processed ?? false,
  });
}

function makeEvent(overrides: {
  txHash?: string;
  contractAddress?: string;
  eventName?: string;
  ledgerSequence?: number;
  eventIndex?: number;
} = {}) {
  return contractEventRepo.upsert({
    txHash: overrides.txHash ?? 'tx-abc',
    contractAddress: overrides.contractAddress ?? 'CONTRACT_A',
    eventName: overrides.eventName ?? 'transfer',
    ledgerSequence: overrides.ledgerSequence ?? 1000,
    eventIndex: overrides.eventIndex ?? 0,
    parameters: { amount: '100' },
    processed: false,
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  __clearAllStores();
});

// ===========================================================================
// blockchainTransactionRepo
// ===========================================================================

describe('blockchainTransactionRepo', () => {
  describe('upsert', () => {
    it('creates a new transaction row', () => {
      const tx = makeTx({ txHash: 'tx-1', blockNumber: 100 });
      expect(tx.txHash).toBe('tx-1');
      expect(tx.blockNumber).toBe(100);
      expect(tx.id).toBeTruthy();
      expect(typeof tx.id).toBe('string');
    });

    it('assigns a uuid id', () => {
      const tx = makeTx({ txHash: 'tx-uuid' });
      expect(tx.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it('updates an existing row on re-upsert', () => {
      makeTx({ txHash: 'tx-1', status: TransactionStatus.PENDING });
      const updated = makeTx({ txHash: 'tx-1', status: TransactionStatus.CONFIRMED });
      expect(updated.status).toBe(TransactionStatus.CONFIRMED);
    });

    it('preserves the original id across updates', () => {
      const first = makeTx({ txHash: 'tx-stable' });
      const second = makeTx({ txHash: 'tx-stable' });
      expect(second.id).toBe(first.id);
    });

    it('preserves createdAt from the first insert', () => {
      const first = makeTx({ txHash: 'tx-cat' });
      const secondAt = new Date(Date.now() + 10_000).toISOString();
      const second = blockchainTransactionRepo.upsert({
        txHash: 'tx-cat',
        blockNumber: 1,
        blockHash: '',
        status: TransactionStatus.CONFIRMED,
        from: '',
        to: '',
        amount: '0',
        fee: '0',
        operationType: 'x',
        createdAt: secondAt,
        processed: false,
      });
      expect(second.createdAt).toBe(first.createdAt);
    });

    it('increments count on each distinct txHash', () => {
      makeTx({ txHash: 'a' });
      makeTx({ txHash: 'b' });
      makeTx({ txHash: 'c' });
      expect(blockchainTransactionRepo.count()).toBe(3);
    });

    it('does not increment count when upserting same txHash', () => {
      makeTx({ txHash: 'x' });
      makeTx({ txHash: 'x' });
      expect(blockchainTransactionRepo.count()).toBe(1);
    });
  });

  describe('findByHash', () => {
    it('returns the row when found', () => {
      makeTx({ txHash: 'find-me' });
      expect(blockchainTransactionRepo.findByHash('find-me')).toBeDefined();
    });

    it('returns undefined for unknown hash', () => {
      expect(blockchainTransactionRepo.findByHash('ghost')).toBeUndefined();
    });
  });

  describe('findByLedger', () => {
    it('returns all transactions for a ledger', () => {
      makeTx({ txHash: 'l1-a', blockNumber: 500 });
      makeTx({ txHash: 'l1-b', blockNumber: 500 });
      makeTx({ txHash: 'l2-a', blockNumber: 600 });
      const result = blockchainTransactionRepo.findByLedger(500);
      expect(result).toHaveLength(2);
      expect(result.map((t) => t.txHash).sort()).toEqual(['l1-a', 'l1-b']);
    });

    it('returns empty array for a ledger with no rows', () => {
      expect(blockchainTransactionRepo.findByLedger(9999)).toEqual([]);
    });
  });

  describe('findFirstByBlockNumberDesc', () => {
    it('returns the transaction with the highest blockNumber', () => {
      makeTx({ txHash: 'low', blockNumber: 100 });
      makeTx({ txHash: 'mid', blockNumber: 200 });
      makeTx({ txHash: 'high', blockNumber: 300 });
      const result = blockchainTransactionRepo.findFirstByBlockNumberDesc();
      expect(result?.txHash).toBe('high');
    });

    it('returns undefined when the store is empty', () => {
      expect(blockchainTransactionRepo.findFirstByBlockNumberDesc()).toBeUndefined();
    });
  });

  describe('orphanByLedger', () => {
    it('marks all transactions in the given ledger as ORPHANED', () => {
      makeTx({ txHash: 'o1', blockNumber: 100 });
      makeTx({ txHash: 'o2', blockNumber: 100 });
      makeTx({ txHash: 'o3', blockNumber: 200 }); // different ledger

      blockchainTransactionRepo.orphanByLedger(100);

      expect(blockchainTransactionRepo.findByHash('o1')?.status).toBe(TransactionStatus.ORPHANED);
      expect(blockchainTransactionRepo.findByHash('o2')?.status).toBe(TransactionStatus.ORPHANED);
      // Row in ledger 200 must NOT be touched
      expect(blockchainTransactionRepo.findByHash('o3')?.status).toBe(TransactionStatus.CONFIRMED);
    });

    it('is a no-op for ledgers with no stored rows', () => {
      expect(() => blockchainTransactionRepo.orphanByLedger(9999)).not.toThrow();
    });
  });

  describe('updateStatus', () => {
    it('changes the status of an existing row', () => {
      makeTx({ txHash: 'upd', status: TransactionStatus.PENDING });
      blockchainTransactionRepo.updateStatus('upd', TransactionStatus.CONFIRMED);
      expect(blockchainTransactionRepo.findByHash('upd')?.status).toBe(TransactionStatus.CONFIRMED);
    });

    it('is a no-op for unknown txHash', () => {
      expect(() =>
        blockchainTransactionRepo.updateStatus('ghost', TransactionStatus.FAILED)
      ).not.toThrow();
    });
  });
});

// ===========================================================================
// contractEventRepo
// ===========================================================================

describe('contractEventRepo', () => {
  describe('eventCompositeKey', () => {
    it('produces a distinct key for different eventIndex values', () => {
      const k1 = eventCompositeKey('tx', 'c', 'transfer', 100, 0);
      const k2 = eventCompositeKey('tx', 'c', 'transfer', 100, 1);
      expect(k1).not.toBe(k2);
    });

    it('produces identical keys for identical inputs', () => {
      const k1 = eventCompositeKey('tx', 'c', 'transfer', 100, 0);
      const k2 = eventCompositeKey('tx', 'c', 'transfer', 100, 0);
      expect(k1).toBe(k2);
    });
  });

  describe('upsert — composite deduplication', () => {
    it('stores a new event', () => {
      makeEvent({ txHash: 'e1', eventIndex: 0 });
      expect(contractEventRepo.count()).toBe(1);
    });

    it('treats same composite key as duplicate (idempotent insert)', () => {
      makeEvent({ txHash: 'e1', contractAddress: 'C', eventName: 'n', ledgerSequence: 100, eventIndex: 0 });
      makeEvent({ txHash: 'e1', contractAddress: 'C', eventName: 'n', ledgerSequence: 100, eventIndex: 0 });
      expect(contractEventRepo.count()).toBe(1);
    });

    it('stores distinct events with different eventIndex (fixes original bug)', () => {
      // Same txHash + contractAddress + eventName + ledgerSequence but DIFFERENT eventIndex
      makeEvent({ txHash: 'e1', contractAddress: 'C', eventName: 'n', ledgerSequence: 100, eventIndex: 0 });
      makeEvent({ txHash: 'e1', contractAddress: 'C', eventName: 'n', ledgerSequence: 100, eventIndex: 1 });
      makeEvent({ txHash: 'e1', contractAddress: 'C', eventName: 'n', ledgerSequence: 100, eventIndex: 2 });
      expect(contractEventRepo.count()).toBe(3);
    });

    it('stores events with same txHash but different eventName as distinct rows', () => {
      makeEvent({ txHash: 'e1', eventName: 'deposit', eventIndex: 0 });
      makeEvent({ txHash: 'e1', eventName: 'withdraw', eventIndex: 0 });
      expect(contractEventRepo.count()).toBe(2);
    });

    it('preserves the original row on duplicate (never overwrites)', () => {
      const first = makeEvent({ txHash: 'stable', eventIndex: 0 });
      const second = contractEventRepo.upsert({
        txHash: 'stable',
        contractAddress: 'CONTRACT_A',
        eventName: 'transfer',
        ledgerSequence: 1000,
        eventIndex: 0,
        parameters: { differentParam: true },
        processed: true,
      });
      // Should return the original row, not the new one
      expect(second.id).toBe(first.id);
      expect(second.parameters).toEqual({ amount: '100' });
    });
  });

  describe('exists', () => {
    it('returns true for an existing composite key', () => {
      makeEvent({ txHash: 'ex', contractAddress: 'C', eventName: 'e', ledgerSequence: 1, eventIndex: 0 });
      expect(contractEventRepo.exists('ex', 'C', 'e', 1, 0)).toBe(true);
    });

    it('returns false when the event has not been stored', () => {
      expect(contractEventRepo.exists('nope', 'C', 'e', 1, 0)).toBe(false);
    });
  });

  describe('countByTxHash', () => {
    it('counts all events for a txHash', () => {
      makeEvent({ txHash: 'multi', eventIndex: 0 });
      makeEvent({ txHash: 'multi', eventIndex: 1 });
      makeEvent({ txHash: 'multi', eventIndex: 2 });
      expect(contractEventRepo.countByTxHash('multi')).toBe(3);
    });

    it('counts only the specific eventIndex when provided', () => {
      makeEvent({ txHash: 'multi2', eventIndex: 0 });
      makeEvent({ txHash: 'multi2', eventIndex: 1 });
      expect(contractEventRepo.countByTxHash('multi2', 0)).toBe(1);
    });

    it('returns 0 for a txHash with no events', () => {
      expect(contractEventRepo.countByTxHash('nobody')).toBe(0);
    });
  });

  describe('findUnprocessed', () => {
    it('returns only unprocessed events', () => {
      makeEvent({ txHash: 'up-1' });
      contractEventRepo.upsert({
        txHash: 'proc-1',
        contractAddress: 'C',
        eventName: 'processed',
        ledgerSequence: 1000,
        eventIndex: 0,
        parameters: {},
        processed: true,
      });
      const unprocessed = contractEventRepo.findUnprocessed();
      expect(unprocessed).toHaveLength(1);
      expect(unprocessed[0].txHash).toBe('up-1');
    });
  });

  describe('crash-restart deduplication (acceptance criteria #3)', () => {
    it('does not duplicate events after simulated re-indexing of the same range', () => {
      // Simulate first run — index a batch of events
      const baseEvent = {
        txHash: 'crash-tx',
        contractAddress: 'CONTRACT_CRASH',
        eventName: 'transfer',
        ledgerSequence: 999,
        eventIndex: 0,
        parameters: { amount: '500' },
        processed: false,
      };
      contractEventRepo.upsert(baseEvent);
      expect(contractEventRepo.count()).toBe(1);

      // Simulate crash + restart — re-index the same event
      contractEventRepo.upsert(baseEvent);
      contractEventRepo.upsert(baseEvent);

      // Must still be exactly 1
      expect(contractEventRepo.count()).toBe(1);
      // And SELECT COUNT(*) = 1 WHERE txHash = X AND eventIndex = Y
      expect(contractEventRepo.countByTxHash('crash-tx', 0)).toBe(1);
    });
  });
});

// ===========================================================================
// rollupTrackerRepo
// ===========================================================================

describe('rollupTrackerRepo', () => {
  describe('findOrCreate', () => {
    it('creates a tracker with zero-value defaults if missing', () => {
      const tracker = rollupTrackerRepo.findOrCreate('soroban_indexer');
      expect(tracker.lastProcessedLedger).toBe(0);
      expect(tracker.lastEventCursor).toBe('');
    });

    it('returns the existing tracker on second call', () => {
      rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: 500 });
      const tracker = rollupTrackerRepo.findOrCreate('soroban_indexer');
      expect(tracker.lastProcessedLedger).toBe(500);
    });
  });

  describe('upsert', () => {
    it('creates a new tracker row', () => {
      const t = rollupTrackerRepo.upsert('test_cursor', { lastProcessedLedger: 100 });
      expect(t.type).toBe('test_cursor');
      expect(t.lastProcessedLedger).toBe(100);
      expect(t.lastEventCursor).toBe('');
    });

    it('updates only the supplied fields', () => {
      rollupTrackerRepo.upsert('test_cursor', {
        lastProcessedLedger: 100,
        lastEventCursor: 'cursor_abc',
      });
      rollupTrackerRepo.upsert('test_cursor', { lastProcessedLedger: 200 });
      const t = rollupTrackerRepo.find('test_cursor');
      expect(t?.lastProcessedLedger).toBe(200);
      // lastEventCursor must be preserved because we didn't supply it in the second upsert
      expect(t?.lastEventCursor).toBe('cursor_abc');
    });

    it('advances the cursor between batches (gap recovery test)', () => {
      // Simulate N−500 seed
      rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: 500 });
      // Simulate batch 1 committed
      rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: 600 });
      // Simulate batch 2 committed
      rollupTrackerRepo.upsert('soroban_indexer', { lastProcessedLedger: 700 });
      const t = rollupTrackerRepo.find('soroban_indexer');
      expect(t?.lastProcessedLedger).toBe(700);
    });
  });

  describe('find', () => {
    it('returns undefined for a cursor type that has never been created', () => {
      expect(rollupTrackerRepo.find('nonexistent')).toBeUndefined();
    });
  });
});

// ===========================================================================
// __clearAllStores isolation
// ===========================================================================

describe('__clearAllStores', () => {
  it('empties all stores between tests', () => {
    makeTx({ txHash: 'before-clear' });
    makeEvent({ txHash: 'before-clear' });
    rollupTrackerRepo.upsert('x', { lastProcessedLedger: 100 });

    __clearAllStores();

    expect(blockchainTransactionRepo.count()).toBe(0);
    expect(contractEventRepo.count()).toBe(0);
    expect(rollupTrackerRepo.find('x')).toBeUndefined();
  });
});
