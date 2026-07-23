'use client'

import { Navigation } from '@/components/layout/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useWalletStore } from '@/store/wallet-store'
import { formatAddress, formatAmount } from '@/lib/utils'
import { DonationChart } from '@/components/features/analytics/donation-chart'
import { ImpactChart } from '@/components/features/analytics/impact-chart'
import { CampaignCardSkeleton, StatsCardSkeleton, TableRowSkeleton } from '@/components/features/loading/skeleton-card'
import { ImpactBadges, getDefaultBadges } from '@/components/features/gamification/impact-badges'
import { useRealTimeTransactions } from '@/hooks/use-real-time-transactions'
import { ExportButton } from '@/components/features/export/export-button'
// ExportButton is now self-contained — no transactions prop needed
import { 
  Heart, 
  TrendingUp, 
  Wallet, 
  ArrowUpRight, 
  CheckCircle2,
  AlertCircle,
  Plus,
  Eye
} from 'lucide-react'
import Link from 'next/link'
import { useState, useEffect } from 'react'

export default function DashboardPage() {
  const { address, balance, isConnected } = useWalletStore()
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    // Simulate data loading
    const timer = setTimeout(() => setIsLoading(false), 1500)
    return () => clearTimeout(timer)
  }, [])

  const badges = getDefaultBadges()

  const mockTransactions = [
    {
      id: '1',
      type: 'donation' as const,
      to: 'Emergency Relief Campaign',
      amount: 500,
      status: 'completed' as const,
      timestamp: new Date(Date.now() - 3600000),
    },
    {
      id: '2',
      type: 'donation' as const,
      to: 'Medical Supplies Campaign',
      amount: 250,
      status: 'completed' as const,
      timestamp: new Date(Date.now() - 86400000),
    },
    {
      id: '3',
      type: 'distribution' as const,
      to: 'Beneficiary #1234',
      amount: 100,
      status: 'completed' as const,
      timestamp: new Date(Date.now() - 172800000),
    },
  ]

  const { transactions } = useRealTimeTransactions(mockTransactions)

  if (!isConnected) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <AlertCircle className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h2 className="text-2xl font-bold mb-2">Wallet Not Connected</h2>
          <p className="text-muted-foreground mb-4">Please connect your wallet to access the dashboard</p>
          <Link href="/auth">
            <Button>Connect Wallet</Button>
          </Link>
        </div>
      </div>
    )
  }

  const mockCampaigns = [
    {
      id: '1',
      title: 'Emergency Relief for Flood Victims',
      targetAmount: 50000,
      raisedAmount: 35000,
      status: 'active',
      category: 'emergency',
    },
    {
      id: '2',
      title: 'Medical Supplies for Children',
      targetAmount: 25000,
      raisedAmount: 22000,
      status: 'active',
      category: 'healthcare',
    },
    {
      id: '3',
      title: 'Education Initiative in Rural Areas',
      targetAmount: 100000,
      raisedAmount: 89000,
      status: 'active',
      category: 'education',
    },
  ]

  const donationData = [
    { month: 'Jan', amount: 200 },
    { month: 'Feb', amount: 350 },
    { month: 'Mar', amount: 450 },
    { month: 'Apr', amount: 300 },
    { month: 'May', amount: 500 },
    { month: 'Jun', amount: 750 },
  ]

  const impactData = [
    { category: 'Emergency', amount: 500 },
    { category: 'Healthcare', amount: 250 },
    { category: 'Education', amount: 150 },
    { category: 'Food', amount: 300 },
    { category: 'Shelter', amount: 200 },
  ]

  const stats = [
    { label: 'Total Donated', value: '$750', icon: Heart, change: '+12%' },
    { label: 'Wallet Balance', value: `${formatAmount(balance)} XLM`, icon: Wallet, change: '+5%' },
    { label: 'Campaigns Supported', value: '3', icon: TrendingUp, change: '+1' },
    { label: 'Impact Score', value: '850', icon: CheckCircle2, change: '+25' },
  ]

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      
      <main className="container py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Dashboard</h1>
          <p className="text-muted-foreground">
            Welcome back! Your wallet: {formatAddress(address || '')}
          </p>
        </div>

        {/* Stats Grid */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 mb-8">
          {isLoading ? (
            <>
              <StatsCardSkeleton />
              <StatsCardSkeleton />
              <StatsCardSkeleton />
              <StatsCardSkeleton />
            </>
          ) : (
            stats.map((stat) => (
              <Card key={stat.label}>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{stat.label}</CardTitle>
                  <stat.icon className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{stat.value}</div>
                  <p className="text-xs text-muted-foreground">
                    <span className="text-green-600">{stat.change}</span> from last month
                  </p>
                </CardContent>
              </Card>
            ))
          )}
        </div>

        <Tabs defaultValue="campaigns" className="space-y-4">
          <TabsList>
            <TabsTrigger value="campaigns">Campaigns</TabsTrigger>
            <TabsTrigger value="transactions">Transactions</TabsTrigger>
            <TabsTrigger value="analytics">Analytics</TabsTrigger>
            <TabsTrigger value="badges">Badges</TabsTrigger>
          </TabsList>

          <TabsContent value="campaigns" className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">Active Campaigns</h2>
              <Link href="/campaigns">
                <Button variant="outline" size="sm">
                  View All <ArrowUpRight className="ml-2 h-4 w-4" />
                </Button>
              </Link>
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {isLoading ? (
                <>
                  <CampaignCardSkeleton />
                  <CampaignCardSkeleton />
                  <CampaignCardSkeleton />
                </>
              ) : (
                mockCampaigns.map((campaign) => (
                  <Card key={campaign.id} className="hover:shadow-lg transition-shadow">
                    <CardHeader>
                      <div className="flex items-start justify-between">
                        <CardTitle className="text-lg">{campaign.title}</CardTitle>
                        <Badge variant="secondary">{campaign.category}</Badge>
                      </div>
                      <CardDescription>
                        {formatAmount(campaign.raisedAmount)} of {formatAmount(campaign.targetAmount)} XLM raised
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-4">
                        <div className="w-full bg-secondary h-2 rounded-full overflow-hidden">
                          <div
                            className="bg-primary h-full transition-all"
                            style={{
                              width: `${(campaign.raisedAmount / campaign.targetAmount) * 100}%`,
                            }}
                          />
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-muted-foreground">
                            {Math.round((campaign.raisedAmount / campaign.targetAmount) * 100)}% funded
                          </span>
                          <Link href={`/campaigns/${campaign.id}`}>
                            <Button size="sm" variant="outline">
                              <Eye className="mr-2 h-4 w-4" />
                              Details
                            </Button>
                          </Link>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))
              )}
            </div>

            <Card className="bg-primary/5 border-primary/20">
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold mb-1">Start Your Own Campaign</h3>
                    <p className="text-sm text-muted-foreground">
                      Create a campaign to help those in need
                    </p>
                  </div>
                  <Link href="/campaigns/create">
                    <Button>
                      <Plus className="mr-2 h-4 w-4" />
                      Create Campaign
                    </Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="transactions" className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">Recent Transactions</h2>
              <div className="flex gap-2">
                <ExportButton filename="aidlink-transactions" />
                <Button variant="outline" size="sm">
                  View All <ArrowUpRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
            </div>

            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>To</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableRowSkeleton />
                  ) : (
                    transactions.map((tx) => (
                      <TableRow key={tx.id} className="animate-in fade-in slide-in-from-top-2 duration-300">
                        <TableCell className="capitalize">{tx.type}</TableCell>
                        <TableCell>{tx.to}</TableCell>
                        <TableCell>{formatAmount(tx.amount)} XLM</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-green-600 border-green-600">
                            {tx.status}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {tx.timestamp.toLocaleDateString()}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </Card>
          </TabsContent>

          <TabsContent value="analytics" className="space-y-4">
            <h2 className="text-xl font-semibold">Your Impact Analytics</h2>
            <div className="grid gap-4 md:grid-cols-2">
              <DonationChart data={donationData} />
              <ImpactChart data={impactData} />
            </div>
          </TabsContent>

          <TabsContent value="badges" className="space-y-4">
            <ImpactBadges badges={badges} />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  )
}
