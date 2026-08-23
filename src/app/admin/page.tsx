'use client';

import React, { useState } from 'react';
import { Navigation } from '@/components/layout/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  Users,
  ShieldCheck,
  Ban,
  Search,
  TrendingUp,
  AlertCircle,
  Clock,
  MoreHorizontal,
} from 'lucide-react'
import { toast } from 'sonner'
import { formatAddress, formatAmount, formatDate } from '@/lib/utils'
import { useLocale } from 'next-intl'
import { withRequireRole } from '@/components/providers/auth-provider'
import { beneficiaryRegistryClient } from '@/lib/soroban/beneficiary-registry'

function AdminPage() {
  const locale = useLocale()
  const [searchQuery, setSearchQuery] = useState('')
  const [loadingId, setLoadingId] = useState<string | null>(null)

  const pendingBeneficiaries = [
    {
      id: '1',
      name: 'John Doe',
      walletAddress: 'GB5XWAMU7QNOZBU4K7L5KGK46XB5HQDJC7W3COSKZQD5NVD4M7Y4Q2K7',
      location: 'Sylhet, Bangladesh',
      status: 'pending',
      submittedAt: new Date(Date.now() - 86400000).toISOString(),
      documents: 3,
    },
    {
      id: '2',
      name: 'Jane Smith',
      walletAddress: 'GD5XWAMU7QNOZBU4K7L5KGK46XB5HQDJC7W3COSKZQD5NVD4M7Y4Q2K8',
      location: 'Dhaka, Bangladesh',
      status: 'pending',
      submittedAt: new Date(Date.now() - 172800000).toISOString(),
      documents: 2,
    },
  ]

  const campaigns = [
    {
      id: '1',
      title: 'Emergency Relief for Flood Victims',
      organizer: 'Red Cross International',
      raisedAmount: 35000,
      targetAmount: 50000,
      status: 'active',
      createdAt: new Date(Date.now() - 604800000).toISOString(),
    },
    {
      id: '2',
      title: 'Medical Supplies for Children',
      organizer: 'Doctors Without Borders',
      raisedAmount: 22000,
      targetAmount: 25000,
      status: 'active',
      createdAt: new Date(Date.now() - 1209600000).toISOString(),
    },
  ]

  const flaggedUsers = [
    {
      id: '1',
      name: 'Suspicious User',
      walletAddress: 'GB5XWAMU7QNOZBU4K7L5KGK46XB5HQDJC7W3COSKZQD5NVD4M7Y4Q2K9',
      flagReason: 'Multiple claim attempts',
      flaggedAt: new Date(Date.now() - 3600000).toISOString(),
    },
  ]

  const stats = [
    { label: 'Total Beneficiaries', value: '1,234', icon: Users, change: '+12%' },
    { label: 'Pending Verifications', value: '45', icon: Clock, change: '+5' },
    { label: 'Active Campaigns', value: '12', icon: TrendingUp, change: '+2' },
    { label: 'Flagged Users', value: '3', icon: AlertCircle, change: '-1' },
  ]

  const handleVerify = async (beneficiaryId: string) => {
    setLoadingId(beneficiaryId)
    try {
      await beneficiaryRegistryClient.updateVerificationStatus(beneficiaryId, 1)
      toast.success(`Beneficiary ${beneficiaryId} verified on-chain.`)
    } catch (err) {
      toast.error('Failed to verify beneficiary on contract')
    } finally {
      setLoadingId(null)
    }
  }

  const handleSuspend = async (beneficiaryId: string) => {
    setLoadingId(beneficiaryId)
    try {
      await beneficiaryRegistryClient.updateVerificationStatus(beneficiaryId, 2)
      toast.warning(`Beneficiary ${beneficiaryId} suspended.`)
    } catch (err) {
      toast.error('Failed to suspend beneficiary on contract')
    } finally {
      setLoadingId(null)
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <Navigation />

      <main className="container py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Admin Portal</h1>
          <p className="text-muted-foreground">
            Manage beneficiaries, campaigns, and platform moderation
          </p>
        </div>

        {/* Stats Grid */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 mb-8">
          {stats.map((stat) => (
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
          ))}
        </div>

        <Tabs defaultValue="beneficiaries" className="space-y-4">
          <TabsList>
            <TabsTrigger value="beneficiaries">Beneficiaries</TabsTrigger>
            <TabsTrigger value="campaigns">Campaigns</TabsTrigger>
            <TabsTrigger value="flagged">Flagged Users</TabsTrigger>
          </TabsList>

          <TabsContent value="beneficiaries" className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">Pending Verifications</h2>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search beneficiaries..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10 w-64"
                />
              </div>
            </div>

            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Wallet Address</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>Documents</TableHead>
                    <TableHead>Submitted</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pendingBeneficiaries.map((beneficiary) => (
                    <TableRow key={beneficiary.id}>
                      <TableCell className="font-medium">{beneficiary.name}</TableCell>
                      <TableCell>{formatAddress(beneficiary.walletAddress)}</TableCell>
                      <TableCell>{beneficiary.location}</TableCell>
                      <TableCell>{beneficiary.documents}</TableCell>
                      <TableCell>{formatDate(beneficiary.submittedAt, locale)}</TableCell>
                      <TableCell>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={() => handleVerify(beneficiary.walletAddress)}
                            disabled={loadingId === beneficiary.walletAddress}
                          >
                            <ShieldCheck className="mr-2 h-4 w-4" />
                            Verify
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => handleSuspend(beneficiary.walletAddress)}
                            disabled={loadingId === beneficiary.walletAddress}
                          >
                            <Ban className="mr-2 h-4 w-4" />
                            Suspend
                          </Button>
                          <Button size="sm" variant="outline">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          </TabsContent>

          <TabsContent value="campaigns" className="space-y-4">
            <h2 className="text-xl font-semibold">Campaign Moderation</h2>
            <div className="grid gap-4">
              {campaigns.map((campaign) => (
                <Card key={campaign.id}>
                  <CardContent className="pt-6">
                    <div className="flex items-center justify-between">
                      <div className="flex-1">
                        <div className="font-semibold mb-1">{campaign.title}</div>
                        <div className="text-sm text-muted-foreground mb-2">
                          By {campaign.organizer}
                        </div>
                        <div className="flex items-center gap-4 text-sm">
                          <span>
                            {formatAmount(campaign.raisedAmount, 2, locale)} /{' '}
                            {formatAmount(campaign.targetAmount, 2, locale)} XLM
                          </span>
                          <Badge variant="secondary">{campaign.status}</Badge>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline">
                          View Details
                        </Button>
                        <Button size="sm" variant="outline">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="flagged" className="space-y-4">
            <h2 className="text-xl font-semibold">Flagged Users</h2>
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Wallet Address</TableHead>
                    <TableHead>Flag Reason</TableHead>
                    <TableHead>Flagged Date</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {flaggedUsers.map((user) => (
                    <TableRow key={user.id}>
                      <TableCell className="font-medium">{user.name}</TableCell>
                      <TableCell>{formatAddress(user.walletAddress)}</TableCell>
                      <TableCell>
                        <Badge variant="destructive">{user.flagReason}</Badge>
                      </TableCell>
                      <TableCell>{formatDate(user.flaggedAt, locale)}</TableCell>
                      <TableCell>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => handleSuspend(user.walletAddress)}
                            disabled={loadingId === user.walletAddress}
                          >
                            <Ban className="mr-2 h-4 w-4" />
                            Suspend
                          </Button>
                          <Button size="sm" variant="outline">
                            Review
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  )
}

export default withRequireRole(AdminPage, ['admin'])
