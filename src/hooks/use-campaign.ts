import { useQuery } from '@tanstack/react-query'
import type { CampaignDetail } from '@/lib/campaigns/data'

async function fetchCampaign(id: string): Promise<CampaignDetail | null> {
  const response = await fetch(`/api/campaigns/${id}`)
  if (!response.ok) {
    throw new Error(`Failed to load campaign (${response.status})`)
  }
  const body: { campaign: CampaignDetail | null } = await response.json()
  return body.campaign
}

/**
 * Fetches a single campaign's detail record from /api/campaigns/[id]
 * (issue #98). Resolves to `null` — not an error — when the id doesn't
 * match any campaign, so callers can render a "not found" state instead
 * of an error state for a perfectly normal outcome like a bad URL.
 */
export function useCampaign(id: string) {
  return useQuery({
    queryKey: ['campaign', id],
    queryFn: () => fetchCampaign(id),
    staleTime: 60_000,
    enabled: Boolean(id),
  })
}
