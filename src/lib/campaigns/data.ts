export interface CampaignListing {
  id: string
  title: string
  description: string
  targetAmount: number
  raisedAmount: number
  status: 'active' | 'completed' | 'paused' | 'pending'
  category: 'emergency' | 'healthcare' | 'education' | 'food' | 'shelter' | 'other'
  ngoName: string
  endDate: string
  imageUrl?: string
}

/**
 * Stand-in campaign dataset. There is no Campaign Manager contract client
 * yet (NEXT_PUBLIC_CAMPAIGN_MANAGER_CONTRACT is declared in .env.example
 * but unimplemented — same situation as the Beneficiary Registry contract
 * before issue #88's ABI stub), so this is the same mock data previously
 * inlined directly in src/app/campaigns/page.tsx, now the single source
 * both the API route and any future contract-backed fetcher can sit
 * behind.
 *
 * The artificial delay simulates realistic upstream latency (a contract
 * call or database round-trip) so the caching layer in
 * src/lib/cache/campaign-cache.ts has something meaningful to save —
 * without it, "cache reduces load" wouldn't be observable in this repo's
 * current mock-data state.
 */
const MOCK_CAMPAIGNS: CampaignListing[] = [
  {
    id: '1',
    title: 'Emergency Relief for Flood Victims',
    description:
      'Providing immediate relief to families affected by severe flooding in the region. Funds will be used for food, shelter, and medical supplies.',
    targetAmount: 50000,
    raisedAmount: 35000,
    status: 'active',
    category: 'emergency',
    ngoName: 'Red Cross International',
    endDate: '2026-06-30',
    imageUrl: '/api/placeholder/400/200',
  },
  {
    id: '2',
    title: 'Medical Supplies for Children',
    description:
      'Supplying essential medical equipment and medicines to children in need across multiple healthcare facilities.',
    targetAmount: 25000,
    raisedAmount: 22000,
    status: 'active',
    category: 'healthcare',
    ngoName: 'Doctors Without Borders',
    endDate: '2026-07-15',
    imageUrl: '/api/placeholder/400/200',
  },
  {
    id: '3',
    title: 'Education Initiative in Rural Areas',
    description: 'Building schools and providing educational resources to underserved rural communities.',
    targetAmount: 100000,
    raisedAmount: 89000,
    status: 'active',
    category: 'education',
    ngoName: 'UNICEF',
    endDate: '2026-08-01',
    imageUrl: '/api/placeholder/400/200',
  },
  {
    id: '4',
    title: 'Food Security Program',
    description: 'Ensuring food security for vulnerable populations through sustainable farming initiatives.',
    targetAmount: 75000,
    raisedAmount: 45000,
    status: 'active',
    category: 'food',
    ngoName: 'World Food Programme',
    endDate: '2026-09-01',
    imageUrl: '/api/placeholder/400/200',
  },
  {
    id: '5',
    title: 'Shelter for Refugees',
    description: 'Providing temporary shelter and essential supplies to displaced families.',
    targetAmount: 150000,
    raisedAmount: 120000,
    status: 'active',
    category: 'shelter',
    ngoName: 'UNHCR',
    endDate: '2026-10-15',
    imageUrl: '/api/placeholder/400/200',
  },
  {
    id: '6',
    title: 'Clean Water Initiative',
    description: 'Installing water purification systems in communities lacking access to clean drinking water.',
    targetAmount: 60000,
    raisedAmount: 58000,
    status: 'active',
    category: 'other',
    ngoName: 'Water.org',
    endDate: '2026-07-30',
    imageUrl: '/api/placeholder/400/200',
  },
]

/**
 * Simulates fetching the campaign list from its eventual real source (a
 * Campaign Manager contract or backend). Swap the body of this function
 * for that real call when it exists — everything downstream (the cache,
 * the route handler, the hook) is written against this signature and
 * won't need to change.
 */
export async function fetchCampaignListings(): Promise<CampaignListing[]> {
  await new Promise((resolve) => setTimeout(resolve, 150))
  return MOCK_CAMPAIGNS
}
