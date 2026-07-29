/**
 * Unit tests for GET /api/v1/admin/health (AC6)
 *
 * Tests the route handler in isolation by mocking:
 *   - next/server  (NextResponse — avoids needing a full Node/Edge runtime)
 *   - getSorobanIndexer  (returns a controlled IndexerStatus)
 *
 * Verifies:
 *   - The response always includes { indexer: { latestIndexed, latestChain,
 *     lagLedgers, isRunning } }
 *   - status is 'ok' when lag ≤ 100 and indexer has made progress
 *   - status is 'degraded' when lag > 100 or indexer has never run
 */

// ---------------------------------------------------------------------------
// Mock next/server before any import that depends on it
// ---------------------------------------------------------------------------
jest.mock('next/server', () => {
  return {
    NextResponse: {
      json: jest.fn((body: unknown, init?: { status?: number }) => ({
        status: init?.status ?? 200,
        json: async () => body,
      })),
    },
  };
});

// ---------------------------------------------------------------------------
// Mock the singleton indexer
// ---------------------------------------------------------------------------
jest.mock('@/blockchain/soroban.indexer', () => ({
  getSorobanIndexer: jest.fn(),
}));

import { getSorobanIndexer } from '@/blockchain/soroban.indexer';

const mockGetSorobanIndexer = getSorobanIndexer as jest.MockedFunction<typeof getSorobanIndexer>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIndexerWithStatus(overrides: {
  latestIndexed?: number;
  latestChain?: number;
  lagLedgers?: number;
  isRunning?: boolean;
}) {
  const status = {
    latestIndexed: overrides.latestIndexed ?? 0,
    latestChain: overrides.latestChain ?? 0,
    lagLedgers: overrides.lagLedgers ?? 0,
    isRunning: overrides.isRunning ?? false,
  };
  return { getIndexerStatus: () => status } as ReturnType<typeof getSorobanIndexer>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v1/admin/health — AC6', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('exports a GET function', async () => {
    mockGetSorobanIndexer.mockReturnValue(makeIndexerWithStatus({}));
    const { GET } = await import('@/app/api/v1/admin/health/route');
    expect(typeof GET).toBe('function');
  });

  it('returns indexer object with all four required keys', async () => {
    mockGetSorobanIndexer.mockReturnValue(
      makeIndexerWithStatus({
        latestIndexed: 1000,
        latestChain: 1000,
        lagLedgers: 0,
        isRunning: false,
      })
    );

    const { GET } = await import('@/app/api/v1/admin/health/route');
    const response = GET();
    const body = await response.json();

    expect(body).toHaveProperty('indexer');
    expect(body.indexer).toMatchObject({
      latestIndexed: 1000,
      latestChain: 1000,
      lagLedgers: 0,
      isRunning: false,
    });
  });

  it('returns status "ok" when lag ≤ 100 and indexer has run', async () => {
    mockGetSorobanIndexer.mockReturnValue(
      makeIndexerWithStatus({
        latestIndexed: 900,
        latestChain: 1000,
        lagLedgers: 100,
        isRunning: false,
      })
    );

    const { GET } = await import('@/app/api/v1/admin/health/route');
    const body = await GET().json();

    expect(body.status).toBe('ok');
  });

  it('returns status "degraded" when lag > 100', async () => {
    mockGetSorobanIndexer.mockReturnValue(
      makeIndexerWithStatus({
        latestIndexed: 800,
        latestChain: 1000,
        lagLedgers: 200,
        isRunning: false,
      })
    );

    const { GET } = await import('@/app/api/v1/admin/health/route');
    const body = await GET().json();

    expect(body.status).toBe('degraded');
  });

  it('returns status "degraded" when indexer has never run (latestIndexed = 0)', async () => {
    mockGetSorobanIndexer.mockReturnValue(
      makeIndexerWithStatus({
        latestIndexed: 0,
        latestChain: 0,
        lagLedgers: 0,
        isRunning: false,
      })
    );

    const { GET } = await import('@/app/api/v1/admin/health/route');
    const body = await GET().json();

    expect(body.status).toBe('degraded');
  });

  it('includes uptime (number) and timestamp (ISO string) at top level', async () => {
    mockGetSorobanIndexer.mockReturnValue(
      makeIndexerWithStatus({ latestIndexed: 500, latestChain: 500, lagLedgers: 0 })
    );

    const { GET } = await import('@/app/api/v1/admin/health/route');
    const body = await GET().json();

    expect(typeof body.uptime).toBe('number');
    expect(typeof body.timestamp).toBe('string');
    // Validate ISO-8601 format
    expect(() => new Date(body.timestamp)).not.toThrow();
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it('reflects isRunning = true when a scan is in progress', async () => {
    mockGetSorobanIndexer.mockReturnValue(
      makeIndexerWithStatus({
        latestIndexed: 999,
        latestChain: 1000,
        lagLedgers: 1,
        isRunning: true,
      })
    );

    const { GET } = await import('@/app/api/v1/admin/health/route');
    const body = await GET().json();

    expect(body.indexer.isRunning).toBe(true);
    // 1 ledger lag with isRunning should still be ok
    expect(body.status).toBe('ok');
  });
});
