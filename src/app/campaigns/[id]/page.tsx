'use client'

import { Navigation } from '@/components/layout/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  CampaignCardSkeleton,
  StatsCardSkeleton,
  TableRowSkeleton,
} from '@/components/features/loading/skeleton-card'
import {
  Calendar,
  MapPin,
  Users,
  ArrowLeft,
  Share2,
  Clock,
  CheckCircle2,
} from 'lucide-react'
import Link from 'next/link'
import { formatAmount, formatDate, formatDateTime } from '@/lib/utils'
import { useLocale } from 'next-intl'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

export default function CampaignDetailPage({ params }: { params: { id: string } }) {
  const locale = useLocale()
  const [isLoading, setIsLoading] = useState(true)
  const [donationAmount, setDonationAmount] = useState('')
  const [isDonating, setIsDonating] = useState(false)

  const campaign = {
    id: params.id,
    title: 'Emergency Relief for Flood Victims',
    description:
      'Providing immediate relief to families affected by severe flooding in the region. Funds will be used for food, shelter, and medical supplies. This campaign aims to support 500 families who have lost their homes and livelihoods due to the devastating floods.',
    targetAmount: 50000,
    raisedAmount: 35000,
    status: 'active',
    category: 'emergency',
    ngoName: 'Red Cross International',
    ngoId: 'ngo-1',
    endDate: '2026-06-30',
    createdAt: '2026-05-01',
    location: {
      country: 'Bangladesh',
      region: 'Sylhet Division',
      city: 'Sylhet',
    },
    beneficiaries: [
      { id: '1', name: 'Family A', status: 'verified', allocatedAmount: 500 },
      { id: '2', name: 'Family B', status: 'verified', allocatedAmount: 500 },
      { id: '3', name: 'Family C', status: 'pending', allocatedAmount: 500 },
    ],
  }

  const recentDonations = [
    { id: '1', donor: 'Anonymous', amount: 500, timestamp: new Date(Date.now() - 3600000).toISOString() },
    { id: '2', donor: '0x1234...5678', amount: 250, timestamp: new Date(Date.now() - 7200000).toISOString() },
    { id: '3', donor: 'Anonymous', amount: 1000, timestamp: new Date(Date.now() - 14400000).toISOString() },
  ]

  const handleDonate = async () => {
    if (!donationAmount || parseFloat(donationAmount) <= 0) {
      toast.error('Please enter a valid donation amount')
      return
    }

    setIsDonating(true)
    try {
      // Simulate donation process
      await new Promise((resolve) => setTimeout(resolve, 2000))
      toast.success('Donation successful!', {
        description: `Thank you for donating ${formatAmount(parseFloat(donationAmount), 2, locale)} XLM`,
      })
      setDonationAmount('')
    } catch (error) {
      toast.error('Donation failed', {
        description: 'Please try again later',
      })
    } finally {
      setIsDonating(false)
    }
  }

  const progress = calculateCampaignProgress(campaign.raisedAmount, campaign.targetAmount)
  const fundingStatus = getCampaignFundingStatus(campaign.raisedAmount, campaign.targetAmount)

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsLoading(false)
    }, 600)

    return () => clearTimeout(timer)
  }, [])

  return (
    <div className="min-h-screen bg-background">
      <Navigation />

      <main className="container py-8">
        <Link href="/campaigns" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground mb-6">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Campaigns
        </Link>

        <div className="grid gap-8 lg:grid-cols-3">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-6">
            {isLoading ? (
              <CampaignCardSkeleton />
            ) : (
              <div>
                <div className="flex items-center gap-2 mb-4">
                  <Badge variant="secondary" className="capitalize">
                    {campaign.category}
                  </Badge>
                  <Badge className="bg-green-600">Active</Badge>
                </div>
                <h1 className="text-3xl font-bold mb-4">{campaign.title}</h1>
                <p className="text-muted-foreground text-lg">{campaign.description}</p>
              </div>
            )}

            {/* Progress Card */}
            {isLoading ? (
              <StatsCardSkeleton />
            ) : (
              <Card>
                <CardHeader>
                  <CardTitle>Funding Progress</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <div className="flex justify-between text-sm mb-2">
                      <span className="text-muted-foreground">Raised</span>
                      <span className="font-medium">
                        {formatAmount(campaign.raisedAmount, 2, locale)} / {formatAmount(campaign.targetAmount, 2, locale)} XLM
                      </span>
                    </div>
                    <div className="w-full bg-secondary h-3 rounded-full overflow-hidden">
                      <div
                        className="bg-primary h-full transition-all"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-sm mt-2">
                      <span className="text-muted-foreground">{progress.toFixed(1)}% funded</span>
                      <span className="text-muted-foreground">
                        {formatAmount(campaign.targetAmount - campaign.raisedAmount, 2, locale)} XLM remaining
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-4 pt-4 border-t">
                    <div className="text-center">
                      <div className="text-2xl font-bold">{campaign.beneficiaries.length}</div>
                      <div className="text-sm text-muted-foreground">Beneficiaries</div>
                    </div>
                    <div className="text-center">
                      <div className="text-2xl font-bold">{recentDonations.length}</div>
                      <div className="text-sm text-muted-foreground">Donors</div>
                    </div>
                    <div className="text-center">
                      <div className="text-2xl font-bold">
                        {Math.ceil((new Date(campaign.endDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))}
                      </div>
                      <div className="text-sm text-muted-foreground">Days Left</div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Campaign Details */}
            {isLoading ? (
              <CampaignCardSkeleton />
            ) : (
              <Card>
                <CardHeader>
                  <CardTitle>Campaign Details</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="flex items-start gap-3">
                      <MapPin className="h-5 w-5 text-muted-foreground mt-0.5" />
                      <div>
                        <div className="font-medium">Location</div>
                        <div className="text-sm text-muted-foreground">
                          {campaign.location.city}, {campaign.location.region}, {campaign.location.country}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <Calendar className="h-5 w-5 text-muted-foreground mt-0.5" />
                      <div>
                        <div className="font-medium">End Date</div>
                        <div className="text-sm text-muted-foreground">{formatDate(campaign.endDate, locale)}</div>
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <Users className="h-5 w-5 text-muted-foreground mt-0.5" />
                      <div>
                        <div className="font-medium">Organizer</div>
                        <div className="text-sm text-muted-foreground">{campaign.ngoName}</div>
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <Clock className="h-5 w-5 text-muted-foreground mt-0.5" />
                      <div>
                        <div className="font-medium">Created</div>
                        <div className="text-sm text-muted-foreground">{formatDate(campaign.createdAt, locale)}</div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Tabs for Beneficiaries and Donations */}
            <Tabs defaultValue="beneficiaries" className="space-y-4">
              <TabsList>
                <TabsTrigger value="beneficiaries">Beneficiaries</TabsTrigger>
                <TabsTrigger value="donations">Recent Donations</TabsTrigger>
              </TabsList>

              <TabsContent value="beneficiaries">
                <Card>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Allocated</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {isLoading ? (
                        <TableRowSkeleton />
                      ) : (
                        campaign.beneficiaries.map((beneficiary) => (
                          <TableRow key={beneficiary.id}>
                            <TableCell>{beneficiary.name}</TableCell>
                            <TableCell>
                              <Badge variant={beneficiary.status === 'verified' ? 'default' : 'secondary'}>
                                {beneficiary.status}
                              </Badge>
                            </TableCell>
                            <TableCell>{formatAmount(beneficiary.allocatedAmount, 2, locale)} XLM</TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </Card>
              </TabsContent>

              <TabsContent value="donations">
                <Card>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Donor</TableHead>
                        <TableHead>Amount</TableHead>
                        <TableHead>Time</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {isLoading ? (
                        <TableRowSkeleton />
                      ) : (
                        recentDonations.map((donation) => (
                          <TableRow key={donation.id}>
                            <TableCell>{donation.donor}</TableCell>
                            <TableCell>{formatAmount(donation.amount, 2, locale)} XLM</TableCell>
                            <TableCell>{formatDateTime(donation.timestamp, locale)}</TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </Card>
              </TabsContent>
            </Tabs>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {isLoading ? (
              <>
                <CampaignCardSkeleton />
                <CampaignCardSkeleton />
                <CampaignCardSkeleton />
              </>
            ) : (
              <>
                {/* Donate Card */}
                <Card>
                  <CardHeader>
                    <CardTitle>Make a Donation</CardTitle>
                    <CardDescription>Support this campaign with a donation</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div>
                      <Label htmlFor="amount">Amount (XLM)</Label>
                      <Input
                        id="amount"
                        type="number"
                        placeholder="Enter amount"
                        value={donationAmount}
                        onChange={(e) => setDonationAmount(e.target.value)}
                        min="1"
                      />
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {[10, 50, 100].map((amount) => (
                        <Button
                          key={amount}
                          variant="outline"
                          size="sm"
                          onClick={() => setDonationAmount(amount.toString())}
                        >
                          {amount} XLM
                        </Button>
                      ))}
                    </div>
                    <Button
                      onClick={handleDonate}
                      disabled={isDonating || !donationAmount}
                      className="w-full"
                      size="lg"
                    >
                      {isDonating ? 'Processing...' : 'Donate Now'}
                    </Button>
                    <p className="text-xs text-center text-muted-foreground">
                      Your donation will be processed securely on the Stellar blockchain
                    </p>
                  </CardContent>
                </Card>

                {/* Share Card */}
                <Card>
                  <CardHeader>
                    <CardTitle>Share Campaign</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Button variant="outline" className="w-full">
                      <Share2 className="mr-2 h-4 w-4" />
                      Share Link
                    </Button>
                  </CardContent>
                </Card>

                {/* Trust Indicators */}
                <Card className="bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800">
                  <CardContent className="pt-6">
                    <div className="flex items-start gap-3">
                      <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-500 mt-0.5" />
                      <div>
                        <div className="font-medium text-green-900 dark:text-green-100 mb-1">Verified Campaign</div>
                        <div className="text-sm text-green-700 dark:text-green-300">
                          This campaign has been verified by AidLink and the organizer is a registered NGO.
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
