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

export interface CampaignBeneficiary {
  id: string
  name: string
  status: 'verified' | 'pending' | 'suspended'
  allocatedAmount: number
}

/**
 * Everything CampaignListing has, plus the extra fields the campaign
 * detail page (/campaigns/[id]) needs that don't belong on list cards
 * (issue #98).
 */
export interface CampaignDetail extends CampaignListing {
  ngoId: string
  createdAt: string
  location: {
    country: string
    region: string
    city: string
  }
  beneficiaries: CampaignBeneficiary[]
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
 * Detail-only fields for each MOCK_CAMPAIGNS entry, keyed by id. Kept
 * separate from MOCK_CAMPAIGNS itself so the listing dataset (and its
 * CampaignListing type) doesn't have to carry fields the list view never
 * uses.
 */
const MOCK_CAMPAIGN_DETAILS: Record<
  string,
  Pick<CampaignDetail, 'ngoId' | 'createdAt' | 'location' | 'beneficiaries'>
> = {
  '1': {
    ngoId: 'ngo-1',
    createdAt: '2026-05-01',
    location: { country: 'Bangladesh', region: 'Sylhet Division', city: 'Sylhet' },
    beneficiaries: [
      { id: '1', name: 'Family A', status: 'verified', allocatedAmount: 500 },
      { id: '2', name: 'Family B', status: 'verified', allocatedAmount: 500 },
      { id: '3', name: 'Family C', status: 'pending', allocatedAmount: 500 },
    ],
  },
  '2': {
    ngoId: 'ngo-2',
    createdAt: '2026-04-10',
    location: { country: 'Kenya', region: 'Nairobi County', city: 'Nairobi' },
    beneficiaries: [
      { id: '1', name: 'Clinic A', status: 'verified', allocatedAmount: 4000 },
      { id: '2', name: 'Clinic B', status: 'pending', allocatedAmount: 3000 },
    ],
  },
  '3': {
    ngoId: 'ngo-3',
    createdAt: '2026-03-20',
    location: { country: 'India', region: 'Bihar', city: 'Patna' },
    beneficiaries: [
      { id: '1', name: 'School A', status: 'verified', allocatedAmount: 20000 },
      { id: '2', name: 'School B', status: 'verified', allocatedAmount: 15000 },
      { id: '3', name: 'School C', status: 'pending', allocatedAmount: 10000 },
    ],
  },
  '4': {
    ngoId: 'ngo-4',
    createdAt: '2026-03-01',
    location: { country: 'Ethiopia', region: 'Oromia', city: 'Adama' },
    beneficiaries: [
      { id: '1', name: 'Farming Co-op A', status: 'verified', allocatedAmount: 12000 },
      { id: '2', name: 'Farming Co-op B', status: 'pending', allocatedAmount: 8000 },
    ],
  },
  '5': {
    ngoId: 'ngo-5',
    createdAt: '2026-02-15',
    location: { country: 'Jordan', region: 'Mafraq', city: 'Zaatari' },
    beneficiaries: [
      { id: '1', name: 'Family D', status: 'verified', allocatedAmount: 900 },
      { id: '2', name: 'Family E', status: 'verified', allocatedAmount: 900 },
      { id: '3', name: 'Family F', status: 'suspended', allocatedAmount: 900 },
    ],
  },
  '6': {
    ngoId: 'ngo-6',
    createdAt: '2026-01-05',
    location: { country: 'Malawi', region: 'Southern Region', city: 'Blantyre' },
    beneficiaries: [
      { id: '1', name: 'Village A', status: 'verified', allocatedAmount: 15000 },
      { id: '2', name: 'Village B', status: 'verified', allocatedAmount: 15000 },
    ],
  },
}

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

/**
 * Simulates fetching a single campaign's full detail record, keyed by id
 * (issue #98). Returns null when no campaign matches, rather than
 * throwing — "not found" is an expected, normal outcome here (e.g. a bad
 * URL), not a fetch failure.
 */
export async function fetchCampaignById(id: string): Promise<CampaignDetail | null> {
  await new Promise((resolve) => setTimeout(resolve, 150))

  const listing = MOCK_CAMPAIGNS.find((c) => c.id === id)
  const details = MOCK_CAMPAIGN_DETAILS[id]

  if (!listing || !details) {
    return null
  }

  return { ...listing, ...details }
}
