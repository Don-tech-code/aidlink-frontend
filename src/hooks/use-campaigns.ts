import { useQuery } from '@tanstack/react-query'
import type { CampaignListing } from '@/lib/campaigns/data'

async function fetchCampaigns(): Promise<CampaignListing[]> {
  const response = await fetch('/api/campaigns')
  if (!response.ok) {
    throw new Error(`Failed to load campaigns (${response.status})`)
  }
  const body: { campaigns: CampaignListing[] } = await response.json()
  return body.campaigns
}

/**
 * Fetches the campaign list from the cached /api/campaigns route (issue
 * #59). React Query's own client-side staleTime is set to match the
 * server's cache TTL — no point re-requesting more often than the server
 * would return fresh data anyway.
 */
export function useCampaigns() {
  return useQuery({
    queryKey: ['campaigns'],
    queryFn: fetchCampaigns,
    staleTime: 30_000,
  })
}
