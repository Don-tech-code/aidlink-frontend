import { type xdr } from '@stellar/stellar-sdk';
import {
  decodeInvokeHostFunctionOp,
  decodePaymentOp,
  getEnvelopeOperations,
} from '@/lib/horizon/envelope-decode';

export interface TransactionEvent {
  txHash: string;
  timestamp: Date;
  type: 'donation' | 'distribution' | 'claim';
  amount: number;
  currency: string;
  recipient?: string;
}

export interface IndexResult {
  events: TransactionEvent[];
  cursor: string;
}

/**
 * Minimal shape of a Horizon `/accounts/:key/transactions` list-endpoint
 * record that indexTransactions relies on. This endpoint (unlike
 * `/payments`) returns `envelope_xdr`, which is required to decode real
 * payment amounts and destinations.
 */
interface HorizonTransactionListItem {
  id: string;
  hash?: string;
  paging_token?: string;
  created_at: string;
  source_account: string;
  successful?: boolean;
  envelope_xdr?: string;
}

const HORIZON_PAGE_SIZE = 200;

function operationsFromEnvelope(envelopeXdr: string | undefined): xdr.Operation[] {
  if (!envelopeXdr) {
    return [];
  }
  try {
    return getEnvelopeOperations(envelopeXdr);
  } catch {
    // Malformed/undecodable envelope XDR — skip this transaction rather
    // than crashing the whole index run.
    return [];
  }
}

/**
 * Decodes a single Horizon transaction record into zero or more
 * TransactionEvents relative to `publicKey` (the account being indexed).
 *
 * - Outgoing `payment` ops (source === publicKey) become `donation` events
 *   with the real XDR-decoded amount and asset code.
 * - Incoming `payment` ops (destination === publicKey) become
 *   `distribution` events — they must never inflate donation totals.
 * - `invokeHostFunction` ops initiated by publicKey are classified via the
 *   shared Soroban function-name map: `claim`-like names become `claim`
 *   events, `distribute`-like names become `distribution` events.
 *   Donation-like Soroban calls (e.g. a contract `donate` entrypoint) are
 *   intentionally NOT emitted as `donation` events: the invocation
 *   operation carries no verifiable transferred amount without decoding
 *   contract call arguments (out of scope here), and crediting badge
 *   progress for an unverified amount would reintroduce the same class of
 *   bug this fix removes.
 * - Operations that don't involve publicKey at all are skipped.
 */
function eventsFromTransaction(
  tx: HorizonTransactionListItem,
  publicKey: string
): TransactionEvent[] {
  const operations = operationsFromEnvelope(tx.envelope_xdr);
  if (operations.length === 0) {
    return [];
  }

  const txHash = tx.hash || tx.id;
  const timestamp = new Date(tx.created_at);
  const events: TransactionEvent[] = [];

  for (const op of operations) {
    try {
      const payment = decodePaymentOp(op, tx.source_account);
      if (payment) {
        const isOutgoing = payment.source === publicKey;
        const isIncoming = payment.destination === publicKey;
        if (!isOutgoing && !isIncoming) {
          continue;
        }

        events.push({
          txHash,
          timestamp,
          type: isOutgoing ? 'donation' : 'distribution',
          amount: payment.amount,
          currency: payment.assetCode,
          recipient: payment.destination,
        });
        continue;
      }

      const invoke = decodeInvokeHostFunctionOp(op, tx.source_account);
      if (invoke && invoke.source === publicKey) {
        if (invoke.type === 'claim' || invoke.type === 'distribution') {
          events.push({
            txHash,
            timestamp,
            type: invoke.type,
            amount: 0,
            currency: 'XLM',
            recipient: invoke.contractId,
          });
        }
      }
    } catch {
      // Skip malformed/unrecognized operations rather than failing the
      // whole transaction.
    }
  }

  return events;
}

export async function indexTransactions(
  publicKey: string,
  networkUrl: string = process.env.NEXT_PUBLIC_STELLAR_NETWORK_URL || 'https://horizon-testnet.stellar.org',
  options: { cursor?: string; maxTransactions?: number } = {}
): Promise<IndexResult> {
  if (!publicKey) {
    return { events: [], cursor: '' };
  }

  const events: TransactionEvent[] = [];
  let currentCursor = options.cursor || '';
  const maxTx = options.maxTransactions || 1000;
  let fetchedCount = 0;

  try {
    let url = `${networkUrl}/accounts/${publicKey}/transactions?order=asc&limit=${HORIZON_PAGE_SIZE}`;
    if (currentCursor) {
      url += `&cursor=${currentCursor}`;
    }

    while (url && fetchedCount < maxTx) {
      const resp = await fetch(url);
      if (!resp.ok) break;

      const data = await resp.json();
      const records: HorizonTransactionListItem[] = data._embedded?.records || [];

      if (records.length === 0) break;

      for (const tx of records) {
        currentCursor = tx.paging_token || tx.id;
        fetchedCount++;
        events.push(...eventsFromTransaction(tx, publicKey));
      }

      if (records.length < HORIZON_PAGE_SIZE || !data._links?.next?.href) {
        break;
      }

      // Be polite to Horizon between pages of the same run.
      await new Promise((res) => setTimeout(res, 100));
      url = data._links.next.href;
    }
  } catch (err) {
    console.error('Failed to index Horizon transactions:', err);
  }

  return { events, cursor: currentCursor };
}
