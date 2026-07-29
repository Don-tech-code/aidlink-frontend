import type { CampaignListing } from './data'

const mockListing: CampaignListing[] = [
  {
    id: '1',
    title: 'Test Campaign',
    description: 'desc',
    targetAmount: 1000,
    raisedAmount: 100,
    status: 'active',
    category: 'emergency',
    ngoName: 'Test NGO',
    endDate: '2026-01-01',
  },
]

jest.mock('./data', () => ({
  fetchCampaignListings: jest.fn(),
}))

import { fetchCampaignListings } from './data'
import { getCachedCampaignListings, invalidateCampaignListingsCache } from './cache'
import { __clearCache } from '@/lib/cache/ttl-cache'

describe('campaign listings cache', () => {
  beforeEach(() => {
    __clearCache()
    jest.clearAllMocks()
    ;(fetchCampaignListings as jest.Mock).mockResolvedValue(mockListing)
  })

  it('fetches from the source on the first call', async () => {
    const result = await getCachedCampaignListings()

    expect(result.cacheHit).toBe(false)
    expect(fetchCampaignListings).toHaveBeenCalledTimes(1)
    expect(result.data).toEqual(mockListing)
  })

  it('serves from cache on a second call within the TTL', async () => {
    await getCachedCampaignListings()
    const second = await getCachedCampaignListings()

    expect(second.cacheHit).toBe(true)
    expect(fetchCampaignListings).toHaveBeenCalledTimes(1)
  })

  it('invalidateCampaignListingsCache forces a re-fetch on the next call', async () => {
    await getCachedCampaignListings()
    invalidateCampaignListingsCache()
    const second = await getCachedCampaignListings()

    expect(second.cacheHit).toBe(false)
    expect(fetchCampaignListings).toHaveBeenCalledTimes(2)
  })
})
