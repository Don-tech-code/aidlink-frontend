/**
 * useBeneficiaryStatus(address)
 *
 * React Query hook that loads the on-chain verification status for a beneficiary
 * address on mount and polls every 30 seconds.
 *
 * Returns the live VerificationStatus fetched from the BENEFICIARY_REGISTRY
 * contract — not component-local state. Refreshing the page will re-fetch from
 * the contract and reflect the true on-chain state.
 */

import { useQuery } from '@tanstack/react-query'
import { getBeneficiaryStatus, ContractNotConfiguredError } from '@/lib/beneficiary/contract'
import { useWalletStore } from '@/store/wallet-store'
import type { VerificationStatus } from '@/types'

// ---------------------------------------------------------------------------
// Query key factory — exported so other hooks can invalidate this query
// ---------------------------------------------------------------------------

export const beneficiaryStatusKeys = {
  all: ['beneficiary-status'] as const,
  address: (address: string) => ['beneficiary-status', address] as const,
}

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export interface BeneficiaryStatusResult {
  /** The on-chain verification status, or 'unverified' when not yet loaded */
  verificationStatus: VerificationStatus
  /** Rejection reason from the contract, populated only when status === 'rejected' */
  rejectionReason: string | undefined
  /** True while the first fetch is in-flight */
  isLoading: boolean
  /** True when a background refetch is happening (not the initial load) */
  isFetching: boolean
  /** The error thrown if the fetch failed */
  error: Error | null
  /** True if CONTRACT_IDS.BENEFICIARY_REGISTRY is empty */
  contractNotConfigured: boolean
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useBeneficiaryStatus(
  address: string | null,
): BeneficiaryStatusResult {
  const { network } = useWalletStore()

  const query = useQuery({
    queryKey: beneficiaryStatusKeys.address(address ?? ''),
    queryFn: async () => {
      if (!address) {
        return { status: 'unverified' as VerificationStatus, rejectionReason: undefined }
      }
      return getBeneficiaryStatus(address, network)
    },
    enabled: !!address,
    // Poll every 30 seconds to pick up admin decisions
    refetchInterval: 30_000,
    // Keep previous data visible while refetching to prevent flicker
    placeholderData: (prev) => prev,
    retry: (failureCount, error) => {
      // Do not retry if the contract is not configured
      if (error instanceof ContractNotConfiguredError) return false
      return failureCount < 2
    },
  })

  const contractNotConfigured = query.error instanceof ContractNotConfiguredError

  return {
    verificationStatus: query.data?.status ?? 'unverified',
    rejectionReason: query.data?.rejectionReason,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    contractNotConfigured,
  }
}
