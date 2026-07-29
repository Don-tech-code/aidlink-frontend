'use client'

import React, { useEffect, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { CheckCircle, Clock, AlertCircle, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { FeeConfirmationDialog } from '@/components/beneficiary/FeeConfirmationDialog'
import { useClaim } from '@/hooks/use-claim'
import { generateClaimToken, isTokenExpiredSync, stroopsToXlm, formatClaimFeeXlm } from '@/lib/beneficiary/claim-token'
import type { Allocation } from '@/types'

interface AllocationCardProps {
  allocation: Allocation
  beneficiaryAddress: string
}

/** Milliseconds before expiry to refresh the token automatically */
const REFRESH_BEFORE_MS = 60_000 // refresh 1 min before expiry

export function AllocationCard({ allocation, beneficiaryAddress }: AllocationCardProps) {
  const [claimToken, setClaimToken] = useState<string>('')
  const [tokenLoading, setTokenLoading] = useState(true)
  const [tokenError, setTokenError] = useState<string | null>(null)

  // ── token generation ──────────────────────────────────────────────────────

  async function refreshToken() {
    setTokenLoading(true)
    setTokenError(null)
    try {
      const token = await generateClaimToken(
        allocation.claimId,
        beneficiaryAddress,
        allocation.campaignId,
        allocation.allocatedAmountStroops,
      )
      setClaimToken(token)
    } catch {
      setTokenError('Failed to generate claim token. Please refresh the page.')
    } finally {
      setTokenLoading(false)
    }
  }

  useEffect(() => {
    refreshToken()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allocation.claimId, beneficiaryAddress])

  // Auto-refresh when the token is about to expire
  useEffect(() => {
    if (!claimToken || tokenLoading) return
    let timer: ReturnType<typeof setTimeout>

    function scheduleRefresh() {
      try {
        const json = atob(
          claimToken.replace(/-/g, '+').replace(/_/g, '/') +
            '=='.slice(0, (4 - (claimToken.length % 4)) % 4),
        )
        const payload = JSON.parse(json)
        if (typeof payload.exp === 'number') {
          const msUntilRefresh =
            payload.exp * 1000 - Date.now() - REFRESH_BEFORE_MS
          if (msUntilRefresh > 0) {
            timer = setTimeout(refreshToken, msUntilRefresh)
          } else {
            refreshToken()
          }
        }
      } catch {
        // malformed token — refresh now
        refreshToken()
      }
    }

    scheduleRefresh()
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimToken, tokenLoading])

  // ── claim hook ────────────────────────────────────────────────────────────

  const { state, startClaim, feeConfirmed, feeDismissed, reset } = useClaim(
    allocation,
    claimToken,
  )

  const isExpired = claimToken ? isTokenExpiredSync(claimToken) : false
  const amountXlm = formatClaimFeeXlm(stroopsToXlm(allocation.allocatedAmountStroops))

  // ── derived UI flags ──────────────────────────────────────────────────────

  const isBusy = ['fetching-fee', 'signing', 'submitting', 'polling'].includes(state.status)
  const claimDisabled =
    isBusy ||
    allocation.isClaimed ||
    isExpired ||
    state.status === 'success' ||
    state.status === 'already-claimed' ||
    state.status === 'token-expired' ||
    state.status === 'not-your-claim' ||
    tokenLoading ||
    !!tokenError

  // ── status badge ──────────────────────────────────────────────────────────

  function StatusBadge() {
    if (allocation.isClaimed || state.status === 'success' || state.status === 'already-claimed') {
      return <Badge className="bg-green-100 text-green-800 border-green-200">Claimed</Badge>
    }
    if (isExpired || state.status === 'token-expired') {
      return <Badge variant="secondary">Token Expired</Badge>
    }
    if (state.status === 'not-your-claim') {
      return <Badge variant="destructive">Wrong Wallet</Badge>
    }
    if (state.status === 'error') {
      return <Badge variant="destructive">Error</Badge>
    }
    return <Badge variant="outline">Unclaimed</Badge>
  }

  // ── status message ────────────────────────────────────────────────────────

  function StatusMessage() {
    if (state.status === 'success' && state.txHash) {
      return (
        <div className="mt-3 rounded-md bg-green-50 border border-green-200 p-3">
          <div className="flex items-start gap-2">
            <CheckCircle className="h-4 w-4 text-green-600 mt-0.5 shrink-0" aria-hidden />
            <div className="min-w-0">
              <p className="text-sm font-medium text-green-800">Claimed successfully!</p>
              <p className="text-xs text-green-700 mt-0.5">Transaction confirmed on-chain.</p>
              <p className="text-xs font-mono text-green-700 mt-1 break-all">{state.txHash}</p>
            </div>
          </div>
        </div>
      )
    }

    if (state.status === 'polling') {
      return (
        <div className="mt-3 rounded-md bg-blue-50 border border-blue-200 p-3">
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 text-blue-600 animate-spin shrink-0" aria-hidden />
            <p className="text-sm text-blue-800">Confirming on-chain…</p>
          </div>
        </div>
      )
    }

    if (state.status === 'already-claimed') {
      return (
        <div className="mt-3 rounded-md bg-amber-50 border border-amber-200 p-3">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" aria-hidden />
            <p className="text-sm text-amber-800">This allocation was already claimed.</p>
          </div>
        </div>
      )
    }

    if (state.status === 'token-expired' || (isExpired && state.status === 'idle')) {
      return (
        <div className="mt-3 rounded-md bg-yellow-50 border border-yellow-200 p-3">
          <div className="flex items-start gap-2">
            <Clock className="h-4 w-4 text-yellow-600 mt-0.5 shrink-0" aria-hidden />
            <div>
              <p className="text-sm text-yellow-800">This claim token has expired. Refresh the page for a new one.</p>
              <button
                onClick={() => { reset(); refreshToken() }}
                className="mt-1 text-xs text-yellow-700 underline hover:no-underline"
              >
                Refresh token
              </button>
            </div>
          </div>
        </div>
      )
    }

    if (state.status === 'not-your-claim') {
      return (
        <div className="mt-3 rounded-md bg-red-50 border border-red-200 p-3">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-red-600 mt-0.5 shrink-0" aria-hidden />
            <p className="text-sm text-red-800">
              This claim token is not for the connected wallet. Connect the correct wallet and try again.
            </p>
          </div>
        </div>
      )
    }

    if (state.status === 'error' && state.error) {
      return (
        <div className="mt-3 rounded-md bg-red-50 border border-red-200 p-3">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-red-600 mt-0.5 shrink-0" aria-hidden />
            <div>
              <p className="text-sm text-red-800">{state.error}</p>
              <button
                onClick={reset}
                className="mt-1 text-xs text-red-700 underline hover:no-underline"
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      )
    }

    return null
  }

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <>
      <Card className={allocation.isClaimed || state.status === 'success' ? 'opacity-75' : ''}>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="text-base font-semibold leading-tight">
              {allocation.campaignName}
            </CardTitle>
            <StatusBadge />
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            Amount: <span className="font-mono font-medium">{amountXlm}</span>
          </p>
        </CardHeader>

        <CardContent className="pb-3">
          {/* QR code section */}
          <div className="flex flex-col items-center gap-2">
            {tokenLoading ? (
              <div className="h-[180px] w-[180px] flex items-center justify-center bg-muted rounded">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Generating QR code" />
              </div>
            ) : tokenError ? (
              <div className="h-[180px] w-[180px] flex flex-col items-center justify-center bg-muted rounded gap-2 text-center p-4">
                <AlertCircle className="h-6 w-6 text-destructive" aria-hidden />
                <p className="text-xs text-muted-foreground">{tokenError}</p>
              </div>
            ) : (
              <div
                className={isExpired ? 'opacity-40 grayscale' : ''}
                aria-label={isExpired ? 'Expired QR code' : `QR code for claim ${allocation.claimId}`}
              >
                <QRCodeSVG
                  value={claimToken}
                  size={180}
                  level="M"
                  includeMargin
                />
              </div>
            )}

            {!tokenLoading && !tokenError && (
              <button
                onClick={() => { reset(); refreshToken() }}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Refresh QR code token"
              >
                <RefreshCw className="h-3 w-3" />
                Refresh token
              </button>
            )}
          </div>

          <StatusMessage />
        </CardContent>

        <CardFooter>
          <Button
            className="w-full"
            onClick={startClaim}
            disabled={claimDisabled}
            aria-busy={isBusy}
          >
            {isBusy ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                {state.status === 'fetching-fee' && 'Estimating fee…'}
                {state.status === 'signing' && 'Waiting for signature…'}
                {state.status === 'submitting' && 'Submitting…'}
                {state.status === 'polling' && 'Confirming on-chain…'}
              </>
            ) : allocation.isClaimed || state.status === 'success' || state.status === 'already-claimed' ? (
              'Already Claimed'
            ) : (
              'Claim Aid'
            )}
          </Button>
        </CardFooter>
      </Card>

      {/* Fee confirmation dialog — shown when state enters awaiting-confirmation */}
      <FeeConfirmationDialog
        open={state.status === 'awaiting-confirmation'}
        estimatedFeeXlm={state.estimatedFeeXlm}
        allocationAmount={amountXlm}
        onConfirm={feeConfirmed}
        onDismiss={feeDismissed}
      />
    </>
  )
}
