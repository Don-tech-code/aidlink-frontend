'use client'

import React from 'react'
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
import { FeeConfirmationDialog } from '@/components/features/donations/fee-confirmation-dialog'
import {
  Calendar,
  MapPin,
  Users,
  ArrowLeft,
  Share2,
  Clock,
  CheckCircle2,
  ExternalLink,
  Loader2,
} from 'lucide-react'
import Link from 'next/link'
import { formatAmount, formatDate } from '@/lib/utils'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import { useDonation, WalletNotConnectedError, classifyDonationError } from '@/hooks/use-donation'
import { useParams, useRouter } from 'next/navigation'
import { calculateCampaignProgress } from '@/lib/utils'

// Horizon testnet explorer base URL for transaction links
const HORIZON_EXPLORER_BASE = 'https://stellar.expert/explorer/testnet/tx'

export default function CampaignDetailPage() {
  const params = useParams<{ id: string }>()
  const campaignId = params.id
  const queryClient = useQueryClient()
  const router = useRouter()

  const [isLoading, setIsLoading] = useState(true)
  const [donationAmount, setDonationAmount] = useState('')

  const { state: donationState, donate, reset: resetDonation, feeConfirmed, feeDismissed } =
    useDonation(campaignId)

  // Derive a simple boolean for the button spinner
  const isDonating =
    donationState.status !== 'idle' &&
    donationState.status !== 'success' &&
    donationState.status !== 'error' &&
    donationState.status !== 'awaiting-confirmation'

  const campaign = {
    id: campaignId,
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
    { id: '2', donor: 'GABC...5678', amount: 250, timestamp: new Date(Date.now() - 7200000).toISOString() },
    { id: '3', donor: 'Anonymous', amount: 1000, timestamp: new Date(Date.now() - 14400000).toISOString() },
  ]

  // ---------------------------------------------------------------------------
  // React to donation state changes
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (donationState.status === 'success' && donationState.txHash) {
      const msg = donationState.isDuplicate
        ? `Duplicate submission detected — original transaction: ${donationState.txHash.slice(0, 8)}…`
        : `Thank you for donating ${formatAmount(parseFloat(donationAmount || '0'))} XLM`

      toast.success('Donation successful!', { description: msg })
      setDonationAmount('')

      // Invalidate campaign query so raisedAmount re-fetches from the contract
      queryClient.invalidateQueries({ queryKey: ['campaigns', campaignId] })

      // Reset hook state after a short delay so the success badge is visible
      const timer = setTimeout(() => resetDonation(), 5000)
      return () => clearTimeout(timer)
    }

    if (donationState.status === 'error' && donationState.error) {
      toast.error('Donation failed', { description: donationState.error })
    }
  }, [donationState.status, donationState.txHash, donationState.error]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // handleDonate
  // ---------------------------------------------------------------------------
  const handleDonate = async () => {
    const amount = parseFloat(donationAmount)

    if (!donationAmount || isNaN(amount) || amount <= 0) {
      toast.error('Please enter a valid donation amount')
      return
    }

    // Stellar minimum: 1 stroop = 0.0000001 XLM
    if (amount < 0.0000001) {
      toast.error('Minimum donation is 0.0000001 XLM (1 stroop)')
      return
    }

    // Validate precision: no more than 7 decimal places
    const decimalPart = donationAmount.split('.')[1]
    if (decimalPart && decimalPart.length > 7) {
      toast.error('Maximum precision is 7 decimal places (1 stroop = 0.0000001 XLM)')
      return
    }

    try {
      await donate(amount)
    } catch (err) {
      if (err instanceof WalletNotConnectedError) {
        toast.error('Wallet not connected', {
          description: 'Please connect your wallet to make a donation',
        })
        router.push('/auth')
      } else {
        console.error('[CampaignDetailPage] donate() threw:', err)
        toast.error('Donation failed', {
          description: classifyDonationError(err),
        })
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Derived UI state
  // ---------------------------------------------------------------------------
  const progress = calculateCampaignProgress(campaign.raisedAmount, campaign.targetAmount)

  useEffect(() => {
    const timer = setTimeout(() => setIsLoading(false), 600)
    return () => clearTimeout(timer)
  }, [])

  // ---------------------------------------------------------------------------
  // Donate button label
  // ---------------------------------------------------------------------------
  function getDonateButtonLabel() {
    switch (donationState.status) {
      case 'fetching-fee':
        return (
          <span className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Calculating fee…
          </span>
        )
      case 'signing':
        return (
          <span className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Waiting for signature…
          </span>
        )
      case 'submitting':
        return (
          <span className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Submitting…
          </span>
        )
      case 'polling':
        return (
          <span className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Confirming on-chain…
          </span>
        )
      case 'success':
        return (
          <span className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4" />
            Donation confirmed!
          </span>
        )
      default:
        return 'Donate Now'
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <Navigation />

      {/* Fee confirmation dialog — shown when useDonation needs user to confirm fee */}
      <FeeConfirmationDialog
        open={donationState.status === 'awaiting-confirmation'}
        estimatedFeeXlm={donationState.estimatedFee}
        donationAmountXlm={parseFloat(donationAmount || '0')}
        onConfirm={feeConfirmed}
        onCancel={feeDismissed}
      />

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
                        {formatAmount(campaign.raisedAmount)} / {formatAmount(campaign.targetAmount)} XLM
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
                        {formatAmount(campaign.targetAmount - campaign.raisedAmount)} XLM remaining
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
                        <div className="text-sm text-muted-foreground">{formatDate(campaign.endDate)}</div>
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
                        <div className="text-sm text-muted-foreground">{formatDate(campaign.createdAt)}</div>
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
                            <TableCell>{formatAmount(beneficiary.allocatedAmount)} XLM</TableCell>
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
                            <TableCell>{formatAmount(donation.amount)} XLM</TableCell>
                            <TableCell>{new Date(donation.timestamp).toLocaleString()}</TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </Card>
              </TabsContent>
            </Tabs>

            {/* Last confirmed transaction link (shown after success) */}
            {donationState.status === 'success' && donationState.txHash && (
              <Card className="border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20">
                <CardContent className="pt-6">
                  <div className="flex items-start gap-3">
                    <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 mt-0.5 shrink-0" />
                    <div className="min-w-0">
                      <p className="font-medium text-green-900 dark:text-green-100 mb-1">
                        Donation confirmed on-chain
                        {donationState.isDuplicate && (
                          <Badge variant="secondary" className="ml-2 text-xs">
                            Duplicate — original hash
                          </Badge>
                        )}
                      </p>
                      <a
                        href={`${HORIZON_EXPLORER_BASE}/${donationState.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 font-mono text-xs text-green-700 dark:text-green-300 hover:underline break-all"
                      >
                        {donationState.txHash}
                        <ExternalLink className="h-3 w-3 shrink-0" />
                      </a>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
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
                        placeholder="Enter amount (min. 0.0000001)"
                        value={donationAmount}
                        onChange={(e) => setDonationAmount(e.target.value)}
                        min="0.0000001"
                        step="0.0000001"
                        disabled={isDonating || donationState.status === 'success'}
                      />
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {[10, 50, 100].map((amount) => (
                        <Button
                          key={amount}
                          variant="outline"
                          size="sm"
                          onClick={() => setDonationAmount(amount.toString())}
                          disabled={isDonating || donationState.status === 'success'}
                        >
                          {amount} XLM
                        </Button>
                      ))}
                    </div>
                    <Button
                      onClick={handleDonate}
                      disabled={
                        isDonating ||
                        !donationAmount ||
                        donationState.status === 'success'
                      }
                      className="w-full"
                      size="lg"
                    >
                      {getDonateButtonLabel()}
                    </Button>

                    {/* Error message */}
                    {donationState.status === 'error' && donationState.error && (
                      <p className="text-sm text-destructive text-center">
                        {donationState.error}
                      </p>
                    )}

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
