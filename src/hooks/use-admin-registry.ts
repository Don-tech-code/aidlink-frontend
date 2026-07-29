/**
 * useAdminRegistry()
 *
 * React Query hook that fetches the list of admin addresses from
 * BENEFICIARY_REGISTRY_CONTRACT get_admins() once per session and checks
 * whether the connected wallet is an admin.
 *
 * Cached for 5 minutes (staleTime: 300_000) to avoid redundant RPC calls.
 */

import { useQuery } from '@tanstack/react-query'
import { getAdmins, ContractNotConfiguredError } from '@/lib/beneficiary/contract'
import { useWalletStore } from '@/store/wallet-store'

// ---------------------------------------------------------------------------
// Query key
// ---------------------------------------------------------------------------

export const adminRegistryKeys = {
  all: ['admin-registry'] as const,
}

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export interface UseAdminRegistryResult {
  /** Full list of on-chain admin addresses */
  admins: string[]
  /** True if the connected wallet address is in the admin list */
  isAdmin: boolean
  /** True while the first fetch is in-flight */
  isLoading: boolean
  /** The error thrown if the fetch failed */
  error: Error | null
  /** True when CONTRACT_IDS.BENEFICIARY_REGISTRY is empty */
  contractNotConfigured: boolean
  /** True when the contract is deployed but get_admins() threw */
  registryUnavailable: boolean
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAdminRegistry(): UseAdminRegistryResult {
  const { network, address, isConnected } = useWalletStore()

  const query = useQuery({
    queryKey: adminRegistryKeys.all,
    queryFn: () => getAdmins(network),
    // Cache for 5 minutes — admin list changes infrequently
    staleTime: 300_000,
    retry: (failureCount, error) => {
      if (error instanceof ContractNotConfiguredError) return false
      // Allow one retry for transient RPC failures
      return failureCount < 1
    },
  })

  const admins = query.data ?? []

  const isAdmin =
    isConnected &&
    !!address &&
    admins.some((a) => a.toLowerCase() === address.toLowerCase())

  const contractNotConfigured = query.error instanceof ContractNotConfiguredError

  // Any non-ContractNotConfiguredError means the registry call itself failed
  const registryUnavailable =
    !!query.error && !contractNotConfigured

  return {
    admins,
    isAdmin,
    isLoading: query.isLoading,
    error: query.error,
    contractNotConfigured,
    registryUnavailable,
  }
}
