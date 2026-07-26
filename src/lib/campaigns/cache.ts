import { getOrSetCache, invalidateCache, type CachedResult } from '@/lib/cache/ttl-cache'
import { fetchCampaignListings, type CampaignListing } from './data'

const CACHE_KEY = 'campaigns:list'

/** Short TTL per issue #59 — long enough to absorb bursts of traffic, short enough that stale listings aren't visible for long. */
export const CAMPAIGN_CACHE_TTL_MS = 30_000

export async function getCachedCampaignListings(): Promise<CachedResult<CampaignListing[]>> {
  return getOrSetCache(CACHE_KEY, CAMPAIGN_CACHE_TTL_MS, fetchCampaignListings)
}

/** Call after any action that changes campaign data (create, moderate, fund) so the next request doesn't serve a stale list for up to CAMPAIGN_CACHE_TTL_MS. */
export function invalidateCampaignListingsCache(): void {
  invalidateCache(CACHE_KEY)
}
