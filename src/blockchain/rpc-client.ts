/**
 * Soroban JSON-RPC and Horizon REST API client helpers.
 *
 * These functions are thin, typed wrappers over `fetch`. They do not hold any
 * state — the indexer manages cursors and retry logic at the layer above.
 *
 * Protocol references:
 *   - Soroban RPC (Protocol 21): https://developers.stellar.org/docs/data/rpc
 *   - Horizon REST API: https://developers.stellar.org/api/horizon
 */

import type {
  SorobanLatestLedger,
  SorobanEventsResponse,
  SorobanEvent,
  HorizonTransactionRecord,
  HorizonPage,
  HorizonLedger,
} from './types';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

let _requestId = 0;

function nextId(): number {
  return ++_requestId;
}

/**
 * Executes a Soroban JSON-RPC call and returns the `result` field.
 * Throws on HTTP errors or RPC-level errors.
 */
async function sorobanRpc<T>(
  rpcUrl: string,
  method: string,
  params: Record<string, unknown>
): Promise<T> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: nextId(),
    method,
    params,
  });

  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!response.ok) {
    throw new Error(
      `Soroban RPC HTTP error: ${response.status} ${response.statusText} (method=${method})`
    );
  }

  const json = (await response.json()) as {
    result?: T;
    error?: { code: number; message: string };
  };

  if (json.error) {
    throw new Error(
      `Soroban RPC error ${json.error.code}: ${json.error.message} (method=${method})`
    );
  }

  if (json.result === undefined) {
    throw new Error(`Soroban RPC returned no result for method=${method}`);
  }

  return json.result;
}

/**
 * Performs a Horizon GET request and returns the parsed JSON body.
 * Throws on non-2xx responses.
 */
async function horizonGet<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(
      `Horizon HTTP error: ${response.status} ${response.statusText} (url=${url})`
    );
  }

  return response.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Soroban RPC: getLatestLedger
// ---------------------------------------------------------------------------

/**
 * Returns the current chain head.
 * Soroban RPC method: `getLatestLedger`
 */
export async function getLatestLedger(rpcUrl: string): Promise<SorobanLatestLedger> {
  return sorobanRpc<SorobanLatestLedger>(rpcUrl, 'getLatestLedger', {});
}

// ---------------------------------------------------------------------------
// txHash resolution cache
// ---------------------------------------------------------------------------

/**
 * Bounded in-memory LRU-style cache for resolved txHash values.
 *
 * Key:   Soroban event ID string (unique per-event, position-based)
 * Value: resolved 64-char hex txHash string
 *
 * The cache is bounded by MAX_CACHE_SIZE entries. When the limit is reached,
 * the oldest quarter of entries (by insertion order) are evicted. This keeps
 * memory bounded while keeping recently-seen events fast to resolve.
 *
 * Scope: module-level singleton — survives across getEvents calls within the
 * same Node.js process (same as batchGetLedgerTransactions's concurrency
 * semantics).
 */
const MAX_CACHE_SIZE = 50_000;

// Map preserves insertion order, which we exploit for eviction.
const txHashCache = new Map<string, string>();

/** Store a resolved txHash in the cache, evicting old entries if needed. */
function cachePut(eventId: string, txHash: string): void {
  if (txHashCache.size >= MAX_CACHE_SIZE) {
    // Evict oldest quarter of entries
    const evictCount = Math.floor(MAX_CACHE_SIZE / 4);
    const keys = txHashCache.keys();
    for (let i = 0; i < evictCount; i++) {
      const next = keys.next();
      if (!next.done) txHashCache.delete(next.value);
    }
  }
  txHashCache.set(eventId, txHash);
}

/** Look up a cached txHash by event ID. Returns undefined on miss. */
function cacheGet(eventId: string): string | undefined {
  return txHashCache.get(eventId);
}

/** Test-only: clear the cache between test runs. */
export function __clearTxHashCache(): void {
  txHashCache.clear();
}

// ---------------------------------------------------------------------------
// Soroban RPC: getEvents (with cursor-based pagination)
// ---------------------------------------------------------------------------

export interface GetEventsOptions {
  /** Start scanning from this ledger sequence (inclusive) */
  startLedger: number;
  /** Contract address filter; if empty string, no contract filter applied */
  contractAddress: string;
  /** Max events per page — protocol cap is 200 */
  limit: number;
  /** Pagination cursor from a previous response */
  cursor?: string;
  /**
   * Horizon base URL used to resolve txHash for events that don't include it
   * directly in the RPC response (pre-Protocol-21 nodes or non-standard nodes).
   * When omitted, missing txHash values receive a sentinel string instead of
   * triggering a Horizon fallback lookup.
   */
  horizonUrl?: string;
}

/** Raw result shape from the Soroban RPC `getEvents` response */
interface RawEventsResult {
  events: RawEvent[];
  latestLedger: number;
  cursor?: string;
}

interface RawEvent {
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  id: string;
  pagingToken: string;
  topic: unknown[];
  value: unknown;
  inSuccessfulContractCall: boolean;
  txHash?: string;
}

/**
 * Parses the positional segments of a Soroban event ID.
 *
 * Format: `<ledgerSequence>-<txOrderInLedger>-<eventIndexInTx>`
 * Example: "12345-2-0" → { ledgerSeq: 12345, txOrder: 2, eventIndex: 0 }
 *
 * Returns null when the format is unexpected (future-proofing).
 */
function parseEventId(
  eventId: string
): { ledgerSeq: number; txOrder: number; eventIndex: number } | null {
  const parts = eventId.split('-');
  if (parts.length < 3) return null;
  const ledgerSeq = parseInt(parts[0], 10);
  const txOrder = parseInt(parts[1], 10);
  const eventIndex = parseInt(parts[parts.length - 1], 10);
  if (isNaN(ledgerSeq) || isNaN(txOrder) || isNaN(eventIndex)) return null;
  return { ledgerSeq, txOrder, eventIndex };
}

/**
 * Returns the sentinel txHash for an event whose real hash cannot be resolved.
 *
 * Sentinel format: `'unresolved:<eventId>'`
 *
 * Properties:
 *   - Starts with 'unresolved:' → detectable with a startsWith check
 *   - Never empty (satisfies the "never ''" requirement)
 *   - Unique per event (eventId encodes ledger+txOrder+eventIndex position)
 *   - Lexicographically outside the 64-char hex hash space
 */
export function makeSentinelTxHash(eventId: string): string {
  return `unresolved:${eventId}`;
}

/**
 * Returns true when a txHash value is an unresolved sentinel.
 * Use this to filter events that still need re-resolution.
 */
export function isUnresolvedTxHash(txHash: string): boolean {
  return txHash.startsWith('unresolved:');
}

/**
 * Fetches one page of Soroban contract events.
 *
 * Soroban RPC method: `getEvents`
 * Protocol 21 pagination uses cursor strings, not numeric offsets.
 *
 * txHash resolution strategy (in priority order):
 *   1. Use e.txHash from the RPC response directly when present.
 *   2. Check the in-process txHashCache for a previously resolved value.
 *   3. If horizonUrl is provided, perform a batched Horizon fallback:
 *      - Group events missing txHash by ledgerSequence.
 *      - For each unique ledger, fetch its full transaction list once.
 *      - Resolve each event using Map<txOrder, txHash>.
 *      - Cache each resolved value.
 *   4. If fallback also fails (network error, tx not found), assign the
 *      sentinel 'unresolved:<eventId>' — never an empty string.
 *
 * Caller is responsible for looping across pages — this function fetches
 * exactly one page.
 */
export async function getEvents(
  rpcUrl: string,
  options: GetEventsOptions
): Promise<SorobanEventsResponse> {
  const filters = options.contractAddress
    ? [{ type: 'contract', contractIds: [options.contractAddress] }]
    : [];

  const pagination: Record<string, unknown> = { limit: options.limit };
  if (options.cursor) {
    pagination.cursor = options.cursor;
  }

  const params: Record<string, unknown> = {
    filters,
    pagination,
  };

  // startLedger is only sent when there is no cursor (cursor implies position)
  if (!options.cursor) {
    params.startLedger = options.startLedger;
  }

  const raw = await sorobanRpc<RawEventsResult>(rpcUrl, 'getEvents', params);

  // ------------------------------------------------------------------
  // Phase 1: assign txHash from RPC response or cache
  // ------------------------------------------------------------------
  //
  // Build an intermediate array that records which events still need
  // a fallback Horizon lookup.  We collect unique (ledgerSeq → txOrder)
  // pairs so we can batch the Horizon calls.

  interface IntermediateEvent {
    raw: RawEvent;
    txHash: string | null; // null = needs fallback
  }

  const intermediate: IntermediateEvent[] = raw.events.map((e) => {
    // Case 1: RPC node returned txHash directly
    if (e.txHash && e.txHash.length > 0) {
      cachePut(e.id, e.txHash);
      return { raw: e, txHash: e.txHash };
    }

    // Case 2: cache hit from a previous call
    const cached = cacheGet(e.id);
    if (cached) {
      return { raw: e, txHash: cached };
    }

    // Case 3: needs fallback
    return { raw: e, txHash: null };
  });

  // ------------------------------------------------------------------
  // Phase 2: batch Horizon fallback for events that still need resolution
  // ------------------------------------------------------------------
  //
  // Group missing events by ledgerSeq, fetch each ledger's transaction
  // list exactly once, then resolve.

  const needsResolution = intermediate.filter((ev) => ev.txHash === null);

  if (needsResolution.length > 0 && options.horizonUrl) {
    // Build: Map<ledgerSeq, Map<txOrder, eventId[]>>
    // We collect eventId[] per txOrder so multiple events in the same
    // transaction are resolved in one pass.
    const ledgerToTxOrderToEvents = new Map<number, Map<number, IntermediateEvent[]>>();

    for (const ev of needsResolution) {
      const pos = parseEventId(ev.raw.id);
      if (!pos) continue; // malformed id — will get sentinel below

      let txOrderMap = ledgerToTxOrderToEvents.get(pos.ledgerSeq);
      if (!txOrderMap) {
        txOrderMap = new Map<number, IntermediateEvent[]>();
        ledgerToTxOrderToEvents.set(pos.ledgerSeq, txOrderMap);
      }

      let evList = txOrderMap.get(pos.txOrder);
      if (!evList) {
        evList = [];
        txOrderMap.set(pos.txOrder, evList);
      }
      evList.push(ev);
    }

    // Fetch one ledger at a time (already batched per ledger, not per event)
    const ledgerSeqs = Array.from(ledgerToTxOrderToEvents.keys());

    await Promise.allSettled(
      ledgerSeqs.map(async (ledgerSeq) => {
        const txOrderMap = ledgerToTxOrderToEvents.get(ledgerSeq)!;
        try {
          const txRecords = await getLedgerTransactions(options.horizonUrl!, ledgerSeq);
          // Build Map<txOrder(0-based), txHash>
          // Horizon returns transactions ordered asc; index is 0-based txOrder.
          const txOrderToHash = new Map<number, string>();
          txRecords.forEach((tx, idx) => {
            txOrderToHash.set(idx, tx.hash);
          });

          // Resolve each event that needed this ledger
          for (const [txOrder, evList] of txOrderMap.entries()) {
            const resolvedHash = txOrderToHash.get(txOrder);
            for (const ev of evList) {
              if (resolvedHash) {
                ev.txHash = resolvedHash;
                cachePut(ev.raw.id, resolvedHash);
              }
              // If txOrder not found, txHash stays null → sentinel assigned below
            }
          }
        } catch {
          // Network error or node not available — all events in this ledger
          // will receive the sentinel value below.
        }
      })
    );
  }

  // ------------------------------------------------------------------
  // Phase 3: assign sentinel to any events still unresolved
  // ------------------------------------------------------------------
  for (const ev of intermediate) {
    if (ev.txHash === null) {
      ev.txHash = makeSentinelTxHash(ev.raw.id);
    }
  }

  // ------------------------------------------------------------------
  // Phase 4: map to SorobanEvent[]
  // ------------------------------------------------------------------
  const events: SorobanEvent[] = intermediate.map((ev) => ({
    type: ev.raw.type,
    ledger: ev.raw.ledger,
    ledgerClosedAt: ev.raw.ledgerClosedAt,
    contractId: ev.raw.contractId,
    id: ev.raw.id,
    pagingToken: ev.raw.pagingToken,
    topic: ev.raw.topic,
    value: ev.raw.value,
    inSuccessfulContractCall: ev.raw.inSuccessfulContractCall,
    txHash: ev.txHash as string, // guaranteed non-null after Phase 3
  }));

  return {
    events,
    latestLedger: raw.latestLedger,
    cursor: raw.cursor,
  };
}

/**
 * Iterates ALL pages of Soroban events from `startLedger`, invoking the
 * callback for each page.  Stops when no more pages are returned or the
 * optional `stopAt` ledger is reached.
 *
 * This is the main entry point used by the indexer's indexContractEvents.
 */
export async function paginateEvents(
  rpcUrl: string,
  options: Omit<GetEventsOptions, 'cursor'> & {
    initialCursor?: string;
    /** Invoked once per page; return false to stop pagination early */
    onPage: (page: SorobanEventsResponse) => Promise<boolean>;
  }
): Promise<{ finalCursor: string; latestLedger: number }> {
  let cursor = options.initialCursor;
  let latestLedger = 0;
  let continueFlag = true;

  while (continueFlag) {
    const page = await getEvents(rpcUrl, {
      startLedger: options.startLedger,
      contractAddress: options.contractAddress,
      limit: options.limit,
      horizonUrl: options.horizonUrl,
      cursor,
    });

    latestLedger = page.latestLedger;

    continueFlag = await options.onPage(page);

    if (!page.cursor || page.events.length === 0) {
      // No more pages
      break;
    }

    cursor = page.cursor;
  }

  return { finalCursor: cursor ?? '', latestLedger };
}

// ---------------------------------------------------------------------------
// Horizon: GET /ledgers/:seq/transactions
// ---------------------------------------------------------------------------

/**
 * Fetches all transactions for a single ledger sequence from Horizon.
 *
 * `include_failed=true` ensures we capture failed transactions too so we can
 * mark them FAILED in our store.
 */
export async function getLedgerTransactions(
  horizonUrl: string,
  ledgerSequence: number
): Promise<HorizonTransactionRecord[]> {
  const url = `${horizonUrl}/ledgers/${ledgerSequence}/transactions?include_failed=true&limit=200&order=asc`;
  const page = await horizonGet<HorizonPage<HorizonTransactionRecord>>(url);
  return page._embedded?.records ?? [];
}

// ---------------------------------------------------------------------------
// Horizon: GET /ledgers/:seq  (for reorg detection)
// ---------------------------------------------------------------------------

/**
 * Fetches the canonical Horizon ledger record for a sequence.
 * The `hash` field is used by reorg detection.
 */
export async function getLedgerDetails(
  horizonUrl: string,
  ledgerSequence: number
): Promise<HorizonLedger> {
  return horizonGet<HorizonLedger>(`${horizonUrl}/ledgers/${ledgerSequence}`);
}

// ---------------------------------------------------------------------------
// Horizon: GET /ledgers/:seq/transactions (batched for multiple ledgers)
// ---------------------------------------------------------------------------

/**
 * Fetches transactions for a window of ledgers in parallel.
 * Returns a flat map of ledgerSequence -> transaction records.
 *
 * Concurrency is controlled by the caller via the `concurrency` argument to
 * prevent flooding the Horizon node — default 5 parallel requests.
 */
export async function batchGetLedgerTransactions(
  horizonUrl: string,
  ledgerSequences: number[],
  concurrency = 5
): Promise<Map<number, HorizonTransactionRecord[]>> {
  const results = new Map<number, HorizonTransactionRecord[]>();

  // Simple p-limit implementation: process in chunks of `concurrency`
  for (let i = 0; i < ledgerSequences.length; i += concurrency) {
    const chunk = ledgerSequences.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      chunk.map(async (seq) => {
        const txs = await getLedgerTransactions(horizonUrl, seq);
        return { seq, txs };
      })
    );

    for (const result of settled) {
      if (result.status === 'fulfilled') {
        results.set(result.value.seq, result.value.txs);
      }
      // Rejected ledgers are skipped gracefully — the indexer will retry on
      // the next cycle when it detects a gap in the cursor.
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Parses the zero-based event index from a Soroban event ID string.
 * Soroban event IDs: `<ledgerSeq>-<txOrderInLedger>-<eventIndexInTx>`
 * e.g. "12345-0-2" -> 2
 */
export function parseEventIndex(eventId: string): number {
  const parts = eventId.split('-');
  if (parts.length >= 3) {
    const idx = parseInt(parts[parts.length - 1], 10);
    return isNaN(idx) ? 0 : idx;
  }
  return 0;
}

/**
 * Derives a human-readable event name from the raw Soroban topic array.
 * The first topic element is conventionally the event name symbol.
 */
export function parseEventName(topic: unknown[]): string {
  if (!Array.isArray(topic) || topic.length === 0) return 'unknown';
  const first = topic[0];
  if (typeof first === 'string') return first;
  // Soroban ScVal symbols are objects: { type: 'symbol', value: 'name' }
  if (typeof first === 'object' && first !== null) {
    const obj = first as Record<string, unknown>;
    if (typeof obj['value'] === 'string') return obj['value'];
    if (typeof obj['sym'] === 'string') return obj['sym'];
  }
  return 'unknown';
}
