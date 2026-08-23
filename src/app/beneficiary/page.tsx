'use client'

import React, { useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { withRequireRole } from '@/components/providers/auth-provider'
import { VerificationBanner } from '@/components/beneficiary/VerificationBanner'
import { useWalletStore } from '@/store/wallet-store'
import type { Beneficiary } from '@/types'

function BeneficiaryPortalPage() {
  const { address, isConnected } = useWalletStore()

  const [beneficiary] = useState<Beneficiary>({
    id: 'beneficiary-current',
    name: 'Current Beneficiary',
    walletAddress: address || '',
    status: 'pending',
    verificationStatus: 'unverified',
    campaignId: 'campaign-current',
    allocatedAmount: 750,
    claimedAmount: 500,
    location: {
      country: 'Nigeria',
      region: 'Lagos',
      city: 'Lagos',
    },
    createdAt: new Date(Date.now() - 7 * 86400000).toISOString(),
  })

  if (!isConnected) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <AlertCircle className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h2 className="text-2xl font-bold mb-2">Wallet Not Connected</h2>
          <p className="text-muted-foreground mb-4">
            Please connect your wallet to access the beneficiary portal
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Beneficiary Portal</h1>
        <p className="text-muted-foreground mt-1">
          Manage your aid disbursements and verification status.
        </p>
      </div>

      <VerificationBanner
        status={beneficiary.verificationStatus}
        rejectionReason={beneficiary.verificationReason}
      />

      <div className="rounded-lg border bg-card p-4">
        <p className="text-sm text-muted-foreground">Wallet: {address}</p>
      </div>
    </div>
  )
}

export default withRequireRole(BeneficiaryPortalPage, ['beneficiary', 'admin'])
