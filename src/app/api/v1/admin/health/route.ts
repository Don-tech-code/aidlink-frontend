/**
 * GET /api/v1/admin/health
 *
 * Returns platform health including the indexer status from the singleton
 * SorobanIndexer.  This endpoint is consumed by the admin dashboard and any
 * external monitoring that needs to detect indexer lag or stalls.
 *
 * Response shape:
 * {
 *   status: 'ok' | 'degraded',
 *   uptime: number,          // process.uptime() in seconds
 *   timestamp: string,       // ISO-8601
 *   indexer: {
 *     latestIndexed: number, // last ledger the indexer committed
 *     latestChain:   number, // current chain head (from RPC)
 *     lagLedgers:    number, // latestChain - latestIndexed
 *     isRunning:     boolean // true if an indexing cycle is in progress
 *   }
 * }
 *
 * HTTP 200 when latestChain - latestIndexed ≤ LAG_WARN_THRESHOLD.
 * HTTP 200 with status='degraded' when lag exceeds threshold, so monitors
 * can differentiate a healthy lag from a stalled indexer without alerting on
 * a 5xx.
 */

import { NextResponse } from 'next/server';
import { getSorobanIndexer } from '@/blockchain/soroban.indexer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Number of ledgers behind the chain head before we report 'degraded'.
 * Stellar produces ~1 ledger per 5 s; 100 ledgers = ~8 minutes of lag.
 */
const LAG_WARN_THRESHOLD = 100;

export function GET(): NextResponse {
  const indexer = getSorobanIndexer();
  const status = indexer.getIndexerStatus();

  const health =
    status.lagLedgers > LAG_WARN_THRESHOLD || (!status.isRunning && status.latestIndexed === 0)
      ? 'degraded'
      : 'ok';

  return NextResponse.json(
    {
      status: health,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      indexer: {
        latestIndexed: status.latestIndexed,
        latestChain: status.latestChain,
        lagLedgers: status.lagLedgers,
        isRunning: status.isRunning,
      },
    },
    { status: 200 }
  );
}
