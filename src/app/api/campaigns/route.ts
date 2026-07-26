import { NextResponse } from 'next/server'
import { getCachedCampaignListings, CAMPAIGN_CACHE_TTL_MS } from '@/lib/campaigns/cache'

/**
 * Campaign listing endpoint (issue #59). Backed by an in-memory short-TTL
 * cache (src/lib/cache/ttl-cache.ts) — see that file's doc comment for why
 * an in-memory cache is the right "simple" choice here.
 *
 * Also sets standard HTTP caching headers so any CDN/edge cache or the
 * browser itself can skip re-hitting this route entirely within the same
 * window, as a second layer on top of the application-level cache.
 */
export async function GET() {
  const { data, cacheHit, expiresInMs } = await getCachedCampaignListings()
  const maxAgeSeconds = Math.max(0, Math.floor(expiresInMs / 1000))

  return NextResponse.json(
    { campaigns: data },
    {
      headers: {
        'Cache-Control': `public, s-maxage=${maxAgeSeconds}, stale-while-revalidate=${Math.floor(
          CAMPAIGN_CACHE_TTL_MS / 1000
        )}`,
        'X-Cache': cacheHit ? 'HIT' : 'MISS',
      },
    }
  )
}
