'use client'

import React, { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { AlertCircle, Loader2, RefreshCw, ShieldCheck, ShieldOff } from 'lucide-react'
import { withRequireRole } from '@/components/providers/auth-provider'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { AllocationCard } from '@/components/beneficiary/AllocationCard'
import { VerificationBanner } from '@/components/beneficiary/VerificationBanner'
import { useWalletStore } from '@/store/wallet-store'
import { useBeneficiaryStatus } from '@/hooks/use-beneficiary-status'
import {
  getContractAllocations,
  AllocationsContractNotConfiguredError,
} from '@/lib/beneficiary/allocations'
import type { Allocation } from '@/types'

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function BeneficiaryPortalPage() {
  const router = useRouter()
  const { address, isConnected, network } = useWalletStore()

  // On-chain verification status
  const { verificationStatus, isLoading: statusLoading } = useBeneficiaryStatus(address)

  // Allocations state
  const [allocations, setAllocations] = useState<Allocation[]>([])
  const [allocLoading, setAllocLoading] = useState(false)
  const [allocError, setAllocError] = useState<string | null>(null)
  const [contractMissing, setContractMissing] = useState(false)

  // Redirect to /auth when wallet is not connected
  useEffect(() => {
    if (!isConnected || !address) {
      router.replace('/auth')
    }
  }, [isConnected, address, router])

  // ---------------------------------------------------------------------------
  // Fetch allocations from the contract
  // ---------------------------------------------------------------------------

  const fetchAllocations = useCallback(async () => {
    if (!address) return
    setAllocLoading(true)
    setAllocError(null)
    setContractMissing(false)

    try {
      const result = await getContractAllocations(address, network)
      setAllocations(result)
    } catch (err) {
      if (err instanceof AllocationsContractNotConfiguredError) {
        setContractMissing(true)
        setAllocError(null)
      } else {
        setAllocError(
          err instanceof Error
            ? err.message
            : 'Failed to load allocations. Please try again.',
        )
      }
    } finally {
      setAllocLoading(false)
    }
  }, [address, network])

  useEffect(() => {
    if (address) {
      fetchAllocations()
    }
  }, [address, fetchAllocations])

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  if (!isConnected || !address) {
    // The useEffect redirect fires asynchronously — show nothing briefly
    return null
  }

  const isVerified = verificationStatus === 'verified'
  const unclaimedAllocations = allocations.filter((a) => !a.isClaimed)
  const claimedAllocations = allocations.filter((a) => a.isClaimed)

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8 space-y-8">
      {/* ── Header ── */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Beneficiary Portal</h1>
        <p className="text-muted-foreground mt-1">
          Manage your aid disbursements. Each QR code below is a signed claim
          token unique to your wallet.
        </p>
      </div>

      {/* ── Verification status banner ── */}
      {!statusLoading && (
        <VerificationBanner status={verificationStatus} />
      )}

      {/* ── Not verified gate ── */}
      {!statusLoading && !isVerified && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 flex items-start gap-3">
          <ShieldOff className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" aria-hidden />
          <div>
            <p className="font-medium text-amber-900 text-sm">Identity verification required</p>
            <p className="text-sm text-amber-800 mt-0.5">
              Your identity must be verified before you can claim aid.{' '}
              {verificationStatus === 'pending'
                ? 'Your submission is under review — check back soon.'
                : 'Submit your proof documents to begin the process.'}
            </p>
          </div>
        </div>
      )}

      {/* ── Verified badge ── */}
      {!statusLoading && isVerified && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-3 flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-green-600 shrink-0" aria-hidden />
          <p className="text-sm font-medium text-green-800">
            Identity verified — you can claim available aid below.
          </p>
        </div>
      )}

      {/* ── Allocations section ── */}
      <section aria-labelledby="allocations-heading">
        <div className="flex items-center justify-between mb-4">
          <h2 id="allocations-heading" className="text-lg font-semibold">
            Available Claims
          </h2>
          <Button
            variant="outline"
            size="sm"
            onClick={fetchAllocations}
            disabled={allocLoading}
            aria-label="Refresh allocations"
          >
            {allocLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden />
            )}
            <span className="ml-1.5">Refresh</span>
          </Button>
        </div>

        {/* Loading skeleton */}
        {allocLoading && (
          <div className="grid gap-4 sm:grid-cols-2">
            {[1, 2].map((n) => (
              <div key={n} className="space-y-3 rounded-lg border p-4">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-[180px] w-[180px] mx-auto" />
                <Skeleton className="h-10 w-full" />
              </div>
            ))}
          </div>
        )}

        {/* Contract not configured */}
        {!allocLoading && contractMissing && (
          <div className="rounded-lg border border-dashed p-8 text-center">
            <AlertCircle className="mx-auto h-8 w-8 text-muted-foreground mb-3" aria-hidden />
            <p className="font-medium text-sm">Contract not configured</p>
            <p className="text-sm text-muted-foreground mt-1">
              The Beneficiary Registry contract address is not set.
              Contact your administrator.
            </p>
          </div>
        )}

        {/* Fetch error */}
        {!allocLoading && allocError && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-red-600 mt-0.5 shrink-0" aria-hidden />
            <div>
              <p className="font-medium text-red-900 text-sm">Failed to load allocations</p>
              <p className="text-sm text-red-800 mt-0.5">{allocError}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={fetchAllocations}
              >
                Try again
              </Button>
            </div>
          </div>
        )}

        {/* Empty state */}
        {!allocLoading && !allocError && !contractMissing && unclaimedAllocations.length === 0 && (
          <div className="rounded-lg border border-dashed p-8 text-center">
            <p className="font-medium text-sm text-muted-foreground">
              No unclaimed allocations
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              You have no pending aid disbursements at this time.
            </p>
          </div>
        )}

        {/* Unclaimed allocations grid */}
        {!allocLoading && unclaimedAllocations.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2">
            {unclaimedAllocations.map((allocation) => (
              <AllocationCard
                key={allocation.claimId}
                allocation={allocation}
                beneficiaryAddress={address}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Claimed allocations ── */}
      {!allocLoading && claimedAllocations.length > 0 && (
        <section aria-labelledby="claimed-heading">
          <h2 id="claimed-heading" className="text-lg font-semibold mb-4">
            Claimed Aid
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {claimedAllocations.map((allocation) => (
              <AllocationCard
                key={allocation.claimId}
                allocation={allocation}
                beneficiaryAddress={address}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

export default withRequireRole(BeneficiaryPortalPage, ['beneficiary', 'admin'])
