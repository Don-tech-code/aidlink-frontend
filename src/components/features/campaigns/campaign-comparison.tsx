'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { GitCompare, Check } from 'lucide-react'
import { formatAmount, calculateCampaignProgress } from '@/lib/utils'

export interface Campaign {
  id: string
  title: string
  description: string
  targetAmount: number
  raisedAmount: number
  category: string
  ngoName: string
  endDate: string
}

interface CampaignComparisonProps {
  campaigns: Campaign[]
}

export function CampaignComparison({ campaigns }: CampaignComparisonProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [selectedCampaigns, setSelectedCampaigns] = useState<Campaign[]>([])

  const toggleCampaign = (campaign: Campaign) => {
    if (selectedCampaigns.find((c) => c.id === campaign.id)) {
      setSelectedCampaigns(selectedCampaigns.filter((c) => c.id !== campaign.id))
    } else if (selectedCampaigns.length < 3) {
      setSelectedCampaigns([...selectedCampaigns, campaign])
    }
  }

  const getProgress = (campaign: Campaign) => calculateCampaignProgress(campaign.raisedAmount, campaign.targetAmount)

  const getDaysRemaining = (endDate: string) => {
    const end = new Date(endDate)
    const now = new Date()
    const diff = Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    return diff > 0 ? diff : 0
  }

  return (
    <>
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            <GitCompare className="mr-2 h-4 w-4" />
            Compare Campaigns
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Compare Campaigns</DialogTitle>
            <DialogDescription>
              Select up to 3 campaigns to compare side by side
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6">
            {/* Campaign Selection */}
            <div className="space-y-3">
              <h3 className="font-semibold">Select Campaigns to Compare</h3>
              <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
                {campaigns.map((campaign) => (
                  <Card
                    key={campaign.id}
                    className={`cursor-pointer transition-all ${
                      selectedCampaigns.find((c) => c.id === campaign.id)
                        ? 'border-primary bg-primary/5'
                        : 'hover:border-primary/50'
                    }`}
                    onClick={() => toggleCampaign(campaign)}
                  >
                    <CardContent className="pt-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate">{campaign.title}</p>
                          <p className="text-xs text-muted-foreground">{campaign.ngoName}</p>
                        </div>
                        {selectedCampaigns.find((c) => c.id === campaign.id) && (
                          <Check className="h-4 w-4 text-primary flex-shrink-0" />
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>

            {/* Comparison Table */}
            {selectedCampaigns.length > 0 && (
              <div className="space-y-3">
                <h3 className="font-semibold">Comparison</h3>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left p-3 font-medium">Metric</th>
                        {selectedCampaigns.map((campaign) => (
                          <th key={campaign.id} className="text-left p-3 font-medium">
                            {campaign.title}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b">
                        <td className="p-3 font-medium">Organization</td>
                        {selectedCampaigns.map((campaign) => (
                          <td key={campaign.id} className="p-3">
                            {campaign.ngoName}
                          </td>
                        ))}
                      </tr>
                      <tr className="border-b">
                        <td className="p-3 font-medium">Category</td>
                        {selectedCampaigns.map((campaign) => (
                          <td key={campaign.id} className="p-3">
                            <Badge variant="secondary">{campaign.category}</Badge>
                          </td>
                        ))}
                      </tr>
                      <tr className="border-b">
                        <td className="p-3 font-medium">Target Amount</td>
                        {selectedCampaigns.map((campaign) => (
                          <td key={campaign.id} className="p-3">
                            {formatAmount(campaign.targetAmount)} XLM
                          </td>
                        ))}
                      </tr>
                      <tr className="border-b">
                        <td className="p-3 font-medium">Raised Amount</td>
                        {selectedCampaigns.map((campaign) => (
                          <td key={campaign.id} className="p-3">
                            {formatAmount(campaign.raisedAmount)} XLM
                          </td>
                        ))}
                      </tr>
                      <tr className="border-b">
                        <td className="p-3 font-medium">Progress</td>
                        {selectedCampaigns.map((campaign) => (
                          <td key={campaign.id} className="p-3">
                            <div className="space-y-2">
                              <Progress value={getProgress(campaign)} className="h-2" />
                              <p className="text-xs text-muted-foreground">
                                {getProgress(campaign).toFixed(1)}%
                              </p>
                            </div>
                          </td>
                        ))}
                      </tr>
                      <tr className="border-b">
                        <td className="p-3 font-medium">Days Remaining</td>
                        {selectedCampaigns.map((campaign) => (
                          <td key={campaign.id} className="p-3">
                            {getDaysRemaining(campaign.endDate)} days
                          </td>
                        ))}
                      </tr>
                      <tr>
                        <td className="p-3 font-medium">Description</td>
                        {selectedCampaigns.map((campaign) => (
                          <td key={campaign.id} className="p-3 text-sm text-muted-foreground">
                            {campaign.description}
                          </td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {selectedCampaigns.length === 0 && (
              <div className="text-center py-8 text-muted-foreground">
                <GitCompare className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>Select campaigns above to compare them</p>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
