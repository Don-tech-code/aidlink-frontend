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
    let url = `${networkUrl}/accounts/${publicKey}/transactions?order=asc&limit=200`;
    if (currentCursor) {
      url += `&cursor=${currentCursor}`;
    }

    while (url && fetchedCount < maxTx) {
      const resp = await fetch(url);
      if (!resp.ok) break;

      const data = await resp.json();
      const records = data._embedded?.records || [];

      if (records.length === 0) break;

      for (const tx of records) {
        currentCursor = tx.paging_token || tx.id;
        fetchedCount++;

        events.push({
          txHash: tx.hash || tx.id,
          timestamp: new Date(tx.created_at),
          type: 'donation',
          amount: parseFloat(tx.fee_charged || '1') / 10000000,
          currency: 'XLM',
          recipient: tx.memo || tx.source_account,
        });
      }

      await new Promise((res) => setTimeout(res, 100));

      if (records.length < 200 || !data._links?.next?.href) {
        break;
      }
      url = data._links.next.href;
    }
  } catch (err) {
    console.error('Failed to index Horizon transactions:', err);
  }

  return { events, cursor: currentCursor };
}
