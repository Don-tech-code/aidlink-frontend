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

type HorizonPaymentRecord = Horizon.ServerApi.OperationRecord & {
  transaction_hash?: string;
  transaction_successful?: boolean;
  created_at?: string;
  paging_token: string;
  memo?: string;
};

type HorizonTransactionRecord = Horizon.ServerApi.TransactionRecord & {
  memo?: string;
};

const DONOR_RANGES = [
  { range: '0-100', min: 0, max: 100 },
  { range: '101-500', min: 101, max: 500 },
  { range: '501-1000', min: 501, max: 1000 },
  { range: '1000+', min: 1001, max: Number.POSITIVE_INFINITY },
] as const;

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

function getRecordAmount(record: HorizonPaymentRecord): number | null {
  if (record.type === 'payment') {
    return Number.parseFloat((record as Horizon.ServerApi.PaymentOperationRecord).amount ?? '0');
  }

  if (record.type === 'create_account') {
    return Number.parseFloat((record as Horizon.ServerApi.CreateAccountOperationRecord).starting_balance ?? '0');
  }

  return null;
}

function getRecordDonor(record: HorizonPaymentRecord): string | null {
  if (record.type === 'payment') {
    return (record as Horizon.ServerApi.PaymentOperationRecord).from ?? null;
  }

  if (record.type === 'create_account') {
    return (record as Horizon.ServerApi.CreateAccountOperationRecord).funder ?? null;
  }

  return (record as { source_account?: string }).source_account ?? null;
}

function decodeCampaignId(memo?: string | null): string | null {
  if (typeof memo === 'string' && memo.startsWith('campaign:')) {
    return memo.slice('campaign:'.length).trim() || null;
  }

  return null;
}

async function getTransactionMemo(
  server: Horizon.Server,
  transactionHash: string,
  memoCache: Map<string, string | null>
): Promise<string | null> {
  if (memoCache.has(transactionHash)) {
    return memoCache.get(transactionHash) ?? null;
  }

  try {
    const transaction = (await server
      .transactions()
      .transaction(transactionHash)
      .call()) as HorizonTransactionRecord;
    const memo = typeof transaction.memo === 'string' ? transaction.memo : null;
    memoCache.set(transactionHash, memo);
    return memo;
  } catch {
    memoCache.set(transactionHash, null);
    return null;
  }
}

async function mapDonationOperation(
  server: Horizon.Server,
  record: HorizonPaymentRecord,
  memoCache: Map<string, string | null>
): Promise<DonationOperation | null> {
  if (record.transaction_successful === false) return null;

  const amount = getRecordAmount(record);
  if (amount === null || Number.isNaN(amount) || amount <= 0) return null;

  const donor = getRecordDonor(record);
  if (!donor) return null;

  const transactionHash = record.transaction_hash || record.paging_token;
  const memo = record.memo ?? (await getTransactionMemo(server, transactionHash, memoCache));

  return {
    transactionHash,
    donor,
    amount,
    createdAt: record.created_at ?? new Date(0).toISOString(),
    campaignId: decodeCampaignId(memo),
  };
}

async function fetchDonationOperations(account: string): Promise<DonationOperation[]> {
  if (!account) return [];

  const server = new Horizon.Server(getHorizonUrl());
  const donations: DonationOperation[] = [];
  const memoCache = new Map<string, string | null>();

  let page = await server.payments().forAccount(account).limit(200).order('desc').call();

  while (page.records.length > 0) {
    for (const record of page.records) {
      const donation = await mapDonationOperation(server, record as HorizonPaymentRecord, memoCache);
      if (donation) donations.push(donation);
    }

    page = await page.next();
  }

  return donations;
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

async function fetchCampaignAnalytics(campaignId: string): Promise<CampaignAnalytics> {
  const operations = await fetchDonationOperations(getAnalyticsAccount());
  return aggregateAnalytics(campaignId, operations);
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
