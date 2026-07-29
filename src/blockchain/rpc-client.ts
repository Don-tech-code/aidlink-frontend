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
 * Fetches one page of Soroban contract events.
 *
 * Soroban RPC method: `getEvents`
 * Protocol 21 pagination uses cursor strings, not numeric offsets.
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

  const events: SorobanEvent[] = raw.events.map((e) => ({
    type: e.type,
    ledger: e.ledger,
    ledgerClosedAt: e.ledgerClosedAt,
    contractId: e.contractId,
    id: e.id,
    pagingToken: e.pagingToken,
    topic: e.topic,
    value: e.value,
    inSuccessfulContractCall: e.inSuccessfulContractCall,
    txHash: e.txHash ?? extractTxHashFromEventId(e.id),
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
 * Soroban event IDs follow the format `<ledger>-<txIndex>-<eventIndex>`.
 * This function extracts the event index from the id string.
 *
 * Note: Soroban RPC Protocol 21+ also returns `txHash` directly on the
 * event object; this is a fallback for older nodes that omit it.
 */
function extractTxHashFromEventId(_id: string): string {
  // The event `id` is NOT the txHash — it's a composite position string.
  // If the RPC response doesn't include txHash directly, we cannot recover
  // it from the event ID alone without an additional Horizon lookup.
  // Return an empty string; callers should guard against this.
  return '';
}

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
