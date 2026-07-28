'use client'

import { Navigation } from '@/components/layout/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CampaignFilters, CampaignFilters as CampaignFiltersType } from '@/components/features/campaigns/campaign-filters'
import { ShareButton } from '@/components/features/social/share-button'
import { CampaignComparison } from '@/components/features/campaigns/campaign-comparison'
import { Search, Heart, Clock } from 'lucide-react'
import { useState, useMemo } from 'react'
import Link from 'next/link'
import { formatAmount, calculateCampaignProgress } from '@/lib/utils'
import { useCampaigns } from '@/hooks/use-campaigns'

export default function CampaignsPage() {
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('all')
  const [filters, setFilters] = useState<CampaignFiltersType>({
    sortBy: 'newest',
    minProgress: 0,
    maxProgress: 100,
    endDate: 'all',
    selectedNGOs: [],
  })

  // Backed by the cached GET /api/campaigns route (issue #59) rather than
  // an inline mock array, so the caching layer actually gets exercised.
  const { data: campaigns = [], isLoading, isError } = useCampaigns()

  const categories = ['all', 'emergency', 'healthcare', 'education', 'food', 'shelter', 'other']
  const availableNGOs = Array.from(new Set(campaigns.map((c) => c.ngoName)))

  const filteredCampaigns = useMemo(() => {
    let result = campaigns.filter(
      (campaign) =>
        (selectedCategory === 'all' || campaign.category === selectedCategory) &&
        (campaign.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          campaign.description.toLowerCase().includes(searchQuery.toLowerCase()))
    )

    // Apply NGO filter
    if (filters.selectedNGOs.length > 0) {
      result = result.filter((campaign) => filters.selectedNGOs.includes(campaign.ngoName))
    }

    // Apply progress filter
    result = result.filter(
      (campaign) => {
        const p = calculateCampaignProgress(campaign.raisedAmount, campaign.targetAmount)
        return p >= filters.minProgress && p <= filters.maxProgress
      }
    )

    // Apply sorting
    result = [...result].sort((a, b) => {
      switch (filters.sortBy) {
        case 'newest':
          return new Date(b.endDate).getTime() - new Date(a.endDate).getTime()
        case 'oldest':
          return new Date(a.endDate).getTime() - new Date(b.endDate).getTime()
        case 'mostFunded':
          return b.raisedAmount - a.raisedAmount
        case 'leastFunded':
          return a.raisedAmount - b.raisedAmount
        case 'endingSoon':
          return new Date(a.endDate).getTime() - new Date(b.endDate).getTime()
        default:
          return 0
      }
    })

    return result
  }, [campaigns, selectedCategory, searchQuery, filters])

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      
      <main className="container py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Aid Campaigns</h1>
          <p className="text-muted-foreground">
            Browse and support humanitarian aid campaigns worldwide
          </p>
        </div>

        {/* Search and Filter */}
        <div className="flex flex-col gap-4 mb-8 md:flex-row md:items-center md:justify-between">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search campaigns..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
          <div className="flex gap-2">
            <CampaignFilters
              filters={filters}
              onFiltersChange={setFilters}
              availableNGOs={availableNGOs}
            />
            <CampaignComparison campaigns={filteredCampaigns} />
            <Link href="/campaigns/create">
              <Button size="sm">
                Create Campaign
              </Button>
            </Link>
          </div>
        </div>

        {/* Category Tabs */}
        <Tabs value={selectedCategory} onValueChange={setSelectedCategory} className="mb-8">
          <TabsList className="w-full md:w-auto overflow-x-auto">
            {categories.map((category) => (
              <TabsTrigger key={category} value={category} className="capitalize">
                {category}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {isLoading && (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-64 rounded-lg border bg-muted/50 animate-pulse" />
            ))}
          </div>
        )}

        {isError && !isLoading && (
          <div className="text-center py-12">
            <h3 className="text-xl font-semibold mb-2">Couldn&apos;t load campaigns</h3>
            <p className="text-muted-foreground">Please try refreshing the page.</p>
          </div>
        )}

        {/* Campaigns Grid */}
        {!isLoading && !isError && (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {filteredCampaigns.map((campaign) => (
            <Card key={campaign.id} className="flex flex-col hover:shadow-lg transition-shadow">
              <CardHeader>
                <div className="flex items-start justify-between mb-2">
                  <Badge variant="secondary" className="capitalize">
                    {campaign.category}
                  </Badge>
                  <Badge className="bg-green-600">Active</Badge>
                </div>
                <CardTitle className="text-xl mb-2">{campaign.title}</CardTitle>
                <CardDescription className="line-clamp-2">
                  {campaign.description}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex-1 flex flex-col">
                <div className="space-y-4 mb-4">
                  <div>
                    <div className="flex justify-between text-sm mb-2">
                      <span className="text-muted-foreground">Progress</span>
                      <span className="font-medium">
                        {formatAmount(campaign.raisedAmount)} / {formatAmount(campaign.targetAmount)} XLM
                      </span>
                    </div>
                    <div className="w-full bg-secondary h-2 rounded-full overflow-hidden">
                      <div
                        className="bg-primary h-full transition-all"
                        style={{
                          width: `${calculateCampaignProgress(campaign.raisedAmount, campaign.targetAmount)}%`,
                        }}
                      />
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Heart className="h-4 w-4" />
                      <span>{campaign.ngoName}</span>
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Clock className="h-4 w-4" />
                      <span>Ends {new Date(campaign.endDate).toLocaleDateString()}</span>
                    </div>
                  </div>
                </div>

                <div className="mt-auto space-y-2">
                  <Link href={`/campaigns/${campaign.id}`} className="block">
                    <Button className="w-full">
                      View Details
                    </Button>
                  </Link>
                  <div className="flex gap-2">
                    <Button variant="outline" className="flex-1">
                      Donate Now
                    </Button>
                    <ShareButton
                      title={campaign.title}
                      description={campaign.description}
                      url={`${typeof window !== 'undefined' ? window.location.origin : ''}/campaigns/${campaign.id}`}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
        )}

        {!isLoading && !isError && filteredCampaigns.length === 0 && (
          <div className="text-center py-12">
            <Heart className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-xl font-semibold mb-2">No campaigns found</h3>
            <p className="text-muted-foreground">
              Try adjusting your search or filter criteria
            </p>
          </div>
        )}
      </main>
    </div>
  )
}
