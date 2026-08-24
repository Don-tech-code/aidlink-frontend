import { NextRequest, NextResponse } from 'next/server';
import { Horizon } from '@stellar/stellar-sdk';

const APP_CONFIG = {
  DEFAULT_NETWORK: process.env.NEXT_PUBLIC_DEFAULT_NETWORK || 'testnet',
};

const NETWORKS = {
  TESTNET: 'https://horizon-testnet.stellar.org',
  MAINNET: 'https://horizon.stellar.org',
  FUTURENET: 'https://horizon-futurenet.stellar.org',
  STANDALONE: 'http://localhost:8000',
};

function getHorizonUrl(): string {
  const network = APP_CONFIG.DEFAULT_NETWORK.toLowerCase();
  if (network === 'mainnet') return NETWORKS.MAINNET;
  if (network === 'futurenet') return NETWORKS.FUTURENET;
  if (network === 'standalone') return NETWORKS.STANDALONE;
  return NETWORKS.TESTNET;
}

function getAnalyticsAccount(): string {
  return (
    process.env.NEXT_PUBLIC_ANALYTICS_ACCOUNT ||
    process.env.NEXT_PUBLIC_DONATION_ACCOUNT ||
    process.env.CAMPAIGN_MANAGER_CONTRACT ||
    ''
  );
}

const DONOR_RANGES = [
  { range: '0-100', min: 0, max: 100 },
  { range: '101-500', min: 101, max: 500 },
  { range: '501-1000', min: 501, max: 1000 },
  { range: '1000+', min: 1001, max: Number.POSITIVE_INFINITY },
] as const;

const MAX_RECORDS = parseInt(process.env.ANALYTICS_MAX_RECORDS || '5000', 10);
const RATE_LIMIT_DELAY_MS = 110;

function decodeCampaignId(memo?: string | null): string | null {
  if (typeof memo === 'string' && memo.startsWith('campaign:')) {
    return memo.slice('campaign:'.length).trim() || null;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

interface DonationOperation {
  transactionHash: string;
  donor: string;
  amount: number;
  createdAt: string;
  campaignId: string | null;
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

interface CampaignAnalytics {
  campaignId: string;
  totalDonations: number;
  totalAmount: number;
  uniqueDonors: number;
  averageDonation: number;
  dailyDonations: { date: string; amount: number }[];
  donorDistribution: { range: string; count: number }[];
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

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const campaignId = searchParams.get('campaignId');
  const cursor = searchParams.get('cursor');

  if (!campaignId) {
    return NextResponse.json(
      { error: 'campaignId is required' },
      { status: 400 },
    );
  }

  const account = getAnalyticsAccount();
  if (!account) {
    return NextResponse.json(
      {
        campaignId,
        totalDonations: 0,
        totalAmount: 0,
        uniqueDonors: 0,
        averageDonation: 0,
        dailyDonations: [],
        donorDistribution: DONOR_RANGES.map(({ range }) => ({ range, count: 0 })),
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
        },
      },
    );
  }

  try {
    const server = new Horizon.Server(getHorizonUrl());
    const { operations, lastCursor } = await fetchCampaignTransactions(
      server,
      account,
      campaignId,
      cursor,
    );

    const analytics = aggregateAnalytics(campaignId, operations);

    return NextResponse.json(
      {
        ...analytics,
        nextCursor: lastCursor,
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
        },
      },
    );
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch analytics' },
      { status: 500 },
    );
  }
}
