## fix(indexer): implement robust Soroban event txHash resolution with sentinel fallback and batch Horizon lookup

---

### Problem

`src/blockchain/rpc-client.ts` contained a silent operational time-bomb in its `getEvents`
implementation. When mapping raw Soroban RPC event objects to `SorobanEvent`, the code fell
back to `extractTxHashFromEventId()` for events that lacked a `txHash` field in the RPC response:

```ts
txHash: e.txHash ?? extractTxHashFromEventId(e.id),
```

The fallback function returned `''` unconditionally, with a comment that explicitly acknowledged
the problem:

```ts
function extractTxHashFromEventId(_id: string): string {
  // The event `id` is NOT the txHash — it's a composite position string.
  // If the RPC response doesn't include txHash directly, we cannot recover
  // it from the event ID alone without an additional Horizon lookup.
  // Return an empty string; callers should guard against this.
  return '';
}
```

This worked silently in Protocol 21 testnet deployments where the RPC node populated `txHash` on
every event — but the behaviour was completely broken on older protocol versions, non-standard
nodes, or any node with a transient bug omitting the field.

#### Downstream consequences of `txHash: ''`

| Consumer | Failure mode |
|---|---|
| `contractEventRepo.upsert` | Composite deduplication key becomes `''::contractAddress::eventName::seq::idx` — multiple events from **different transactions** in the same ledger collapse into the same bucket if they share `eventName` and `eventIndex` |
| `blockchainTransactionRepo.findByHash('')` | Always returns `undefined`; every cross-reference lookup for events with an empty txHash silently breaks |
| Admin health endpoint `lagLedgers` | Event store grows slower than expected (deduplication collisions drop events on the floor), so lag is over-reported |
| `contractEventRepo.countByTxHash('')` | Returns the count of **all** broken events — a meaningless number that could trigger false fraud-detection alerts |

---

### Solution

This PR implements a correct, robust txHash resolution strategy with four ordered phases, a
bounded in-memory cache, a re-resolution cycle for events that could not be resolved at ingest
time, and a `SorobanEvent.txHash` type change that makes the contract explicit in the type system.

#### Resolution phases (inside `getEvents`)

```
Phase 1 → e.txHash present in RPC response?
              YES → use it directly, populate cache
              NO  ↓
Phase 2 → cache hit for this eventId?
              YES → use cached value
              NO  ↓
Phase 3 → horizonUrl provided?
              YES → batch Horizon lookup (one call per unique ledgerSeq)
                        resolved? → use it, populate cache
                        not found? ↓
              NO  ↓
Phase 4 → assign sentinel: 'unresolved:<eventId>'
```

The sentinel `'unresolved:<eventId>'` is:
- **Never empty** — satisfies the hard "never `''`" requirement
- **Unique per event** — the Soroban event `id` encodes `<ledger>-<txOrder>-<eventIndex>`, so
  two events from different transactions can never share a sentinel
- **Detectable** — starts with `'unresolved:'`; callers use `isUnresolvedTxHash(txHash)`
- **Outside the real hash space** — Stellar transaction hashes are always exactly 64 lowercase
  hex characters; a sentinel beginning with `'unresolved:'` can never be confused with one

#### Batch Horizon lookup (constraint: ≤ 1 call per unique `<ledgerSeq, txOrder>` pair)

Events missing `txHash` are grouped by `ledgerSeq` before any network calls are made. For each
unique `ledgerSeq`, a single `GET /ledgers/:seq/transactions?order=asc&limit=200` call is issued
against Horizon. The response is indexed as `Map<txOrderInLedger, txHash>` and all events in
that ledger are resolved from the in-memory index. A page of 200 events all from the same ledger
that all lack `txHash` triggers **one** Horizon call, not 200.

#### In-memory LRU-style cache

A module-level `Map<eventId, txHash>` caches every resolved value. Bounded to 50,000 entries;
when the limit is reached, the oldest 25% of entries (insertion-ordered) are evicted. The cache
persists across `getEvents` calls within the same Node.js process.

#### Re-resolution cycle (`resolveUnresolvedEvents`)

A new public method on `SorobanIndexer` handles the backlog of sentinel events stored during
periods when Horizon was unavailable:

1. `contractEventRepo.findBySentinel()` finds all rows with `txHash.startsWith('unresolved:')`
2. The embedded `eventId` is parsed from each sentinel string
3. Events are grouped by `ledgerSeq`; one `getLedgerTransactions` call per ledger
4. `contractEventRepo.updateTxHash(sentinel, ..., resolvedHash)` re-keys the row atomically
5. Unresolved sentinels survive intact if Horizon is still unavailable

---

### Files changed

#### `src/blockchain/types.ts`

- `SorobanEvent.txHash` narrowed from `string | undefined` → `string`
- Updated JSDoc to document the sentinel contract and detection pattern

#### `src/blockchain/rpc-client.ts`

- **Removed** `extractTxHashFromEventId` (the stub that returned `''`)
- **Added** 4-phase resolution pipeline inside `getEvents`
- **Added** bounded LRU-style `txHashCache` (`MAX_CACHE_SIZE = 50_000`)
- **Added** `makeSentinelTxHash(eventId: string): string` — exported helper
- **Added** `isUnresolvedTxHash(txHash: string): boolean` — exported helper
- **Added** `__clearTxHashCache(): void` — test-only cache reset
- **Added** `parseEventId(eventId)` — internal helper parsing `<ledger>-<txOrder>-<eventIndex>`
- **Added** `horizonUrl?: string` to `GetEventsOptions` and `paginateEvents` options (backward compatible)

#### `src/blockchain/repository.ts`

- **Added** `contractEventRepo.findByHash(txHash)`
- **Added** `contractEventRepo.findBySentinel()`
- **Added** `contractEventRepo.updateTxHash(sentinelTxHash, contractAddress, eventName, ledgerSequence, eventIndex, resolvedTxHash)` — atomically re-keys sentinel row to real-hash row; preserves existing winner on parallel resolution race

#### `src/blockchain/soroban.indexer.ts`

- **Removed** `event.txHash ?? ''` — `txHash` is always non-empty after `getEvents`
- **Added** `horizonUrl` to the `paginateEvents` call
- **Added** `getLedgerTransactions` to imports
- **Added** `resolveUnresolvedEvents(): Promise<void>` — public re-resolution cycle

#### `src/blockchain/__tests__/soroban.indexer.test.ts`

- Updated `jest.mock` block to expose `getLedgerTransactions`, `makeSentinelTxHash`,
  `isUnresolvedTxHash`, `__clearTxHashCache`
- Added 8 new test suites (TXAC1–TXAC8), 43 new tests on top of 38 existing

#### `docs/PR_TXHASH_RESOLUTION.md`

- This file — full PR description for reference

---

### Test coverage

| Suite | What it verifies |
|---|---|
| **TXAC1** | Every `SorobanEvent` has `txHash !== ''` even when the RPC response omits `txHash` |
| **TXAC2** | Two events with distinct `id` fields but both missing `txHash` receive distinct sentinels |
| **TXAC3** | Event `id = '12345-2-0'` where Horizon ledger 12345 tx at index 2 has a known hash — `resolveUnresolvedEvents` updates the stored row correctly |
| **TXAC4** | Two events that would have collided on `txHash: ''` now produce distinct composite keys and are stored as two separate rows |
| **TXAC5** | 100 events with no `txHash` in RPC response → `contractEventRepo.countByTxHash('') === 0` |
| **TXAC6** | Full re-resolution cycle: sentinel → `resolveUnresolvedEvents()` → `findByHash(resolvedHash)` returns updated row; sentinel gone; Horizon failure leaves sentinel intact |
| **TXAC7** | `npm run test` and `npm run type-check` pass with no regressions |
| **TXAC8** | Property-based: 200 random event IDs → `makeSentinelTxHash` never returns `''`; 50 random real hashes never flagged as unresolved |

**Results:** 81 blockchain tests pass, 0 failures. Zero new TypeScript errors in `src/blockchain/`.

---

### Before / after

**Before:**
```ts
function extractTxHashFromEventId(_id: string): string {
  return ''; // acknowledged known limitation
}

txHash: e.txHash ?? extractTxHashFromEventId(e.id), // always '' on miss

const txHash = event.txHash ?? ''; // redundant double-guard in indexer
```

**After:**
```ts
// Phase 4 sentinel — never ''
ev.txHash = makeSentinelTxHash(ev.raw.id); // e.g. 'unresolved:12345-2-0'

// In getEvents return mapping — guaranteed non-null
txHash: ev.txHash as string,

// In indexer — no guard needed, type is now `string`
const txHash = event.txHash;
```

---

### Design decisions

**Why sentinel strings instead of throwing / dropping the event?**
Dropping causes undetectable data loss. Throwing halts the entire indexer on a single bad RPC
node. Storing with a sentinel preserves the event record in full fidelity, keeps it out of the
broken-deduplication bucket, and allows a background cycle to repair it once Horizon is reachable.

**Why `'unresolved:<eventId>'` specifically?**
The Stellar transaction hash space is exactly 64 lowercase hex characters. Any string starting
with `'unresolved:'` is provably outside that space and is detectable with a simple `startsWith`
check. The embedded `eventId` makes sentinels debuggable and guarantees uniqueness by construction.

**Why not call `getTransaction` by hash from the Soroban RPC?**
The Soroban RPC `getTransaction` method requires a hash as input — it doesn't accept a
ledger+order position. Going from `ledgerSeq + txOrderInLedger` to a hash requires listing the
ledger's full transaction set, which Horizon's `GET /ledgers/:seq/transactions` already does
efficiently and is an already-imported dependency.

**Why batch per ledger instead of per event?**
A 200-event RPC page from a node that omits `txHash` could trigger 200 parallel Horizon calls
per-event. Grouping by `ledgerSeq` collapses this to at most `distinct(ledgerSeq)` calls per
page — usually 1–3 for a page of 200 events in normal indexing cadence.

---

### Checklist

- [x] No new npm dependencies introduced
- [x] `paginateEvents` callback signature unchanged
- [x] `SorobanEvent.txHash` field type remains `string` (sentinel is a valid `string`)
- [x] `indexTransaction` and `indexEvent` public method signatures unchanged
- [x] `maxBufferSize` flush boundary still respected
- [x] Fallback Horizon calls batched per ledger, not per event
- [x] Composite deduplication key guaranteed unique for all events regardless of resolution state
- [x] `contractEventRepo.countByTxHash('')` returns `0` in production after this fix
- [x] All 81 blockchain tests pass
- [x] `npm run type-check` produces zero errors in `src/blockchain/`
- [x] Pre-existing test failures in unrelated modules are unchanged
