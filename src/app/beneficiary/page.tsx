'use client'

import { Navigation } from '@/components/layout/navigation'
import { VerificationBanner } from '@/components/beneficiary/VerificationBanner'
import { VerificationWorkflow } from '@/components/beneficiary/VerificationWorkflow'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { QRCodeSVG } from 'qrcode.react'
import { Wallet, QrCode, History, CheckCircle2, Clock, AlertCircle } from 'lucide-react'
import { useWalletStore } from '@/store/wallet-store'
import { formatAddress, formatAmount, formatDate } from '@/lib/utils'
import { useLocale } from 'next-intl'
import type { ProofSubmissionPayload } from '@/components/beneficiary/ProofSubmissionForm'
import type { Beneficiary } from '@/types'
import { useState } from 'react'
import { toast } from 'sonner'

export default function BeneficiaryPage() {
  const locale = useLocale()
  const { address, balance, isConnected } = useWalletStore()
  const [showQR, setShowQR] = useState(false)
  const [beneficiary, setBeneficiary] = useState<Beneficiary>({
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
          <p className="text-muted-foreground mb-4">Please connect your wallet to access the beneficiary portal</p>
        </div>
      </div>
    )
  }

  const claims = [
    {
      id: '1',
      campaignTitle: 'Emergency Relief for Flood Victims',
      amount: 500,
      status: 'completed',
      claimedAt: new Date(Date.now() - 86400000).toISOString(),
      txHash: '0x1234...5678',
    },
    {
      id: '2',
      campaignTitle: 'Medical Supplies for Children',
      amount: 250,
      status: 'pending',
      claimedAt: null,
      txHash: null,
    },
  ]

  const availableClaims = claims.filter((c) => c.status === 'pending')
  const completedClaims = claims.filter((c) => c.status === 'completed')

  const handleClaim = async (_claimId: string) => {
    try {
      // Simulate claim process
      await new Promise((resolve) => setTimeout(resolve, 2000))
      toast.success('Aid claimed successfully!', {
        description: 'Your claim has been processed on the blockchain',
      })
    } catch {
      toast.error('Failed to claim aid', {
        description: 'Please try again later',
      })
    }
  }

  const handleSubmitProof = async ({ proof, submittedAt }: ProofSubmissionPayload) => {
    await new Promise((resolve) => setTimeout(resolve, 1200))
    setBeneficiary((currentBeneficiary) => ({
      ...currentBeneficiary,
      walletAddress: address || currentBeneficiary.walletAddress,
      status: 'pending',
      verificationStatus: 'pending',
      verificationProof: proof,
      verificationSubmittedAt: submittedAt,
      verificationReason: undefined,
      verificationRejectedAt: undefined,
    }))
    toast.success('Verification proof submitted', {
      description: 'Your proof is now under review.',
    })
  }

  const isVerified = beneficiary.verificationStatus === 'verified'

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      
      <main className="container py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Beneficiary Portal</h1>
          <p className="text-muted-foreground">Claim your allocated aid and track your claim history</p>
        </div>

        {/* Wallet Overview */}
        <div className="grid gap-6 md:grid-cols-3 mb-8">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Wallet Address</CardTitle>
              <Wallet className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-sm font-medium">{formatAddress(address || '')}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Available Balance</CardTitle>
              <Wallet className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{formatAmount(balance, 2, locale)} XLM</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending Claims</CardTitle>
              <Clock className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{availableClaims.length}</div>
            </CardContent>
          </Card>
        </div>

        <VerificationBanner status={beneficiary.verificationStatus} rejectionReason={beneficiary.verificationReason} />

        {/* Available Claims */}
        <div className="mb-8">
          <h2 className="text-xl font-semibold mb-4">Available Claims</h2>
          {isVerified ? (
            availableClaims.length > 0 ? (
              <div className="grid gap-4 md:grid-cols-2">
                {availableClaims.map((claim) => (
                  <Card key={claim.id}>
                    <CardHeader>
                      <CardTitle>{claim.campaignTitle}</CardTitle>
                      <CardDescription>{formatAmount(claim.amount, 2, locale)} XLM available to claim</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <Button onClick={() => handleClaim(claim.id)} className="w-full" size="lg">
                        Claim Aid
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => setShowQR(!showQR)}
                        className="w-full"
                      >
                        <QrCode className="mr-2 h-4 w-4" />
                        {showQR ? 'Hide QR Code' : 'Show QR Code'}
                      </Button>
                      {showQR && (
                        <div className="flex justify-center rounded-lg bg-white p-4">
                          <QRCodeSVG value={address || ''} size={200} />
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : (
              <Card>
                <CardContent className="pt-6">
                  <div className="text-center py-8">
                    <Clock className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                    <h3 className="text-lg font-semibold mb-2">No Available Claims</h3>
                    <p className="text-muted-foreground">New approved aid allocations will appear here.</p>
                  </div>
                </CardContent>
              </Card>
            )
          ) : (
            <VerificationWorkflow beneficiary={beneficiary} onSubmitProof={handleSubmitProof} />
          )}
        </div>

        {/* Claim History */}
        <div>
          <h2 className="text-xl font-semibold mb-4">Claim History</h2>
          {completedClaims.length > 0 ? (
            <div className="space-y-4">
              {completedClaims.map((claim) => (
                <Card key={claim.id}>
                  <CardContent className="pt-6">
                    <div className="flex items-center justify-between">
                      <div className="flex-1">
                        <div className="font-semibold mb-1">{claim.campaignTitle}</div>
                        <div className="text-sm text-muted-foreground">
                          Claimed {formatAmount(claim.amount, 2, locale)} XLM
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {formatDate(claim.claimedAt || '', locale)}
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <Badge className="bg-green-600">Completed</Badge>
                        <CheckCircle2 className="h-5 w-5 text-green-600" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="pt-6">
                <div className="text-center py-8">
                  <History className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                  <h3 className="text-lg font-semibold mb-2">No Claim History</h3>
                  <p className="text-muted-foreground">Your claimed aid will appear here</p>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </main>
    </div>
  )
}
