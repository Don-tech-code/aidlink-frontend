import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Horizon } from '@stellar/stellar-sdk';
import { APP_CONFIG, CONTRACT_IDS, NETWORKS } from '@/config/constants';

export interface CampaignAnalytics {
  campaignId: string;
  totalDonations: number;
  totalAmount: number;
  uniqueDonors: number;
  averageDonation: number;
  dailyDonations: { date: string; amount: number }[];
  donorDistribution: { range: string; count: number }[];
}

type DonationOperation = {
  transactionHash: string;
  donor: string;
  amount: number;
  createdAt: string;
  campaignId: string | null;
};

type AnalyticsCursor = {
  lastCursor: string | null;
  lastFetchTime: string | null;
};

const DONOR_RANGES = [
  { range: '0-100', min: 0, max: 100 },
  { range: '101-500', min: 101, max: 500 },
  { range: '501-1000', min: 501, max: 1000 },
  { range: '1000+', min: 1001, max: Number.POSITIVE_INFINITY },
] as const;

const MAX_RECORDS = parseInt(
  (typeof process !== 'undefined' && (process.env as Record<string, string | undefined>)?.ANALYTICS_MAX_RECORDS) || '5000',
  10,
);

const RATE_LIMIT_DELAY_MS = 110;

function env(key: string): string {
  try {
    return (
      (typeof process !== 'undefined' &&
        (process.env as Record<string, string | undefined>)?.[key]) ||
      ''
    );
  } catch {
    return '';
  }
}

function getAnalyticsAccount(): string {
  return (
    env('NEXT_PUBLIC_ANALYTICS_ACCOUNT') ||
    env('NEXT_PUBLIC_DONATION_ACCOUNT') ||
    CONTRACT_IDS.CAMPAIGN_MANAGER
  );
}

function getHorizonUrl(): string {
  const network = APP_CONFIG.DEFAULT_NETWORK.toLowerCase();

  if (network === 'mainnet') return NETWORKS.MAINNET;
  if (network === 'futurenet') return NETWORKS.FUTURENET;
  if (network === 'standalone') return NETWORKS.STANDALONE;

  return NETWORKS.TESTNET;
}

function decodeCampaignId(memo?: string | null): string | null {
  if (typeof memo === 'string' && memo.startsWith('campaign:')) {
    return memo.slice('campaign:'.length).trim() || null;
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeAmountFromXDR(envelopeXdr: string): number | null {
  try {
    const xdr = typeof window !== 'undefined'
      ? (window as any).__stellar_xdr
      : null;

    if (!xdr) return null;

    const envelope = xdr.TransactionEnvelope.fromXDR(envelopeXdr, 'base64');
    const tx = envelope.v1()?.tx() || envelope.feeBump()?.tx()?.innerTx()?.v1()?.tx();
    if (!tx) return null;

    for (const op of tx.operations()) {
      const body = op.body();
      if (body.switch() === 1) {
        const payment = body.paymentOp();
        const amount = payment.amount().shifted().toNumber();
        return amount;
      }
    }

    return null;
  } catch {
    return null;
  }
}

function getDonorFromXDR(envelopeXdr: string): string | null {
  try {
    const xdr = typeof window !== 'undefined'
      ? (window as any).__stellar_xdr
      : null;

    if (!xdr) return null;

    const envelope = xdr.TransactionEnvelope.fromXDR(envelopeXdr, 'base64');
    const tx = envelope.v1()?.tx() || envelope.feeBump()?.tx()?.innerTx()?.v1()?.tx();
    if (!tx) return null;

    const sourceAccount = tx.sourceAccount().accountId();
    return sourceAccount;
  } catch {
    return null;
  }
}

async function fetchTransactionsPage(
  server: Horizon.Server,
  account: string,
  cursor?: string | null,
  limit: number = 200,
): Promise<{ records: any[]; nextCursor: string | null }> {
  try {
    let builder = server
      .transactions()
      .forAccount(account)
      .limit(limit)
      .order('desc');

    if (cursor) {
      builder = builder.cursor(cursor);
    }

    const page = await builder.call();
    return {
      records: page.records,
      nextCursor: page.next?.()?.cursor?.() ?? null,
    };
  } catch {
    return { records: [], nextCursor: null };
  }
}

function mapTransactionToDonation(
  record: any,
  campaignId: string,
): DonationOperation | null {
  const memo = typeof record.memo === 'string' ? record.memo : null;
  const memoCampaignId = decodeCampaignId(memo);

  if (memoCampaignId !== campaignId) return null;

  const transactionHash = record.hash;
  if (!transactionHash) return null;

  const sourceAccount = record.source_account;
  if (!sourceAccount) return null;

  const operations = record.operation_count ?? 0;
  if (operations === 0) return null;

  return {
    transactionHash,
    donor: sourceAccount,
    amount: 0,
    createdAt: record.created_at ?? new Date(0).toISOString(),
    campaignId: memoCampaignId,
  };
}

async function fetchCampaignTransactions(
  server: Horizon.Server,
  account: string,
  campaignId: string,
  startCursor?: string | null,
  maxRecords: number = MAX_RECORDS,
): Promise<{ operations: DonationOperation[]; lastCursor: string | null }> {
  const operations: DonationOperation[] = [];
  const seenHashes = new Set<string>();
  let currentCursor = startCursor;
  let pagesFetched = 0;
  const maxPages = Math.ceil(maxRecords / 200);

  while (pagesFetched < maxPages && operations.length < maxRecords) {
    const { records, nextCursor } = await fetchTransactionsPage(
      server,
      account,
      currentCursor,
    );

    if (records.length === 0) break;

    for (const record of records) {
      const memo = typeof record.memo === 'string' ? record.memo : null;
      const memoCampaignId = decodeCampaignId(memo);

      if (memoCampaignId !== campaignId) continue;

      const transactionHash = record.hash;
      if (!transactionHash || seenHashes.has(transactionHash)) continue;

      seenHashes.add(transactionHash);

      const sourceAccount = record.source_account;
      if (!sourceAccount) continue;

      const operationCount = record.operation_count ?? 0;
      if (operationCount === 0) continue;

      operations.push({
        transactionHash,
        donor: sourceAccount,
        amount: 0,
        createdAt: record.created_at ?? new Date(0).toISOString(),
        campaignId: memoCampaignId,
      });

      if (operations.length >= maxRecords) break;
    }

    pagesFetched++;
    currentCursor = nextCursor;

    if (!nextCursor) break;

    await sleep(RATE_LIMIT_DELAY_MS);
  }

  return {
    operations,
    lastCursor: currentCursor,
  };
}

function aggregateAnalytics(campaignId: string, operations: DonationOperation[]): CampaignAnalytics {
  const seenTransactionHashes = new Set<string>();
  const donors = new Set<string>();
  const dailyTotals = new Map<string, number>();
  const donorTotals = new Map<string, number>();

  let totalAmount = 0;
  let totalDonations = 0;

  for (const operation of operations) {
    if (operation.campaignId !== campaignId) continue;
    if (seenTransactionHashes.has(operation.transactionHash)) continue;

    seenTransactionHashes.add(operation.transactionHash);
    donors.add(operation.donor);

    totalDonations += 1;
    totalAmount += operation.amount;

    const date = operation.createdAt.slice(0, 10);
    dailyTotals.set(date, (dailyTotals.get(date) ?? 0) + operation.amount);
    donorTotals.set(operation.donor, (donorTotals.get(operation.donor) ?? 0) + operation.amount);
  }

  const donorDistribution = DONOR_RANGES.map(({ range, min, max }) => ({
    range,
    count: Array.from(donorTotals.values()).filter((amount) => amount >= min && amount <= max)
      .length,
  }));

  return {
    campaignId,
    totalDonations,
    totalAmount,
    uniqueDonors: donors.size,
    averageDonation: totalDonations > 0 ? totalAmount / totalDonations : 0,
    dailyDonations: Array.from(dailyTotals.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, amount]) => ({ date, amount })),
    donorDistribution,
  };
}

async function fetchCampaignAnalytics(
  campaignId: string,
  cursor?: string | null,
): Promise<CampaignAnalytics & { nextCursor: string | null }> {
  const account = getAnalyticsAccount();
  if (!account) {
    return {
      campaignId,
      totalDonations: 0,
      totalAmount: 0,
      uniqueDonors: 0,
      averageDonation: 0,
      dailyDonations: [],
      donorDistribution: DONOR_RANGES.map(({ range }) => ({ range, count: 0 })),
      nextCursor: null,
    };
  }

  const server = new Horizon.Server(getHorizonUrl());
  const { operations, lastCursor } = await fetchCampaignTransactions(
    server,
    account,
    campaignId,
    cursor,
  );

  const analytics = aggregateAnalytics(campaignId, operations);

  return {
    ...analytics,
    nextCursor: lastCursor,
  };
}

export function useAnalytics(campaignId?: string) {
  const resolvedCampaignId = campaignId || '1';
  const query = useQuery({
    queryKey: ['analytics', resolvedCampaignId, getAnalyticsAccount(), getHorizonUrl()],
    queryFn: () => fetchCampaignAnalytics(resolvedCampaignId),
    staleTime: 60_000,
    enabled: Boolean(resolvedCampaignId),
  });

  const refresh = useCallback(async () => {
    await query.refetch();
  }, [query]);

  return {
    analytics: query.data ?? null,
    loading: query.isLoading || query.isFetching,
    error: query.error ? 'Failed to load analytics' : null,
    refresh,
  };
}
