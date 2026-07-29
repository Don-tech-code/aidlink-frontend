/**
 * usePendingVerifications()
 *
 * React Query hook that fetches paginated pending verification entries from
 * BENEFICIARY_REGISTRY_CONTRACT list_pending_verifications(cursor, limit).
 *
 * Implements cursor-based pagination: each page exposes loadMore() which
 * appends the next page to the accumulated list.
 */

import { useCallback, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  listPendingVerifications,
  ContractNotConfiguredError,
} from '@/lib/beneficiary/contract'
import type { PendingVerificationEntry } from '@/lib/beneficiary/contract'
import { useWalletStore } from '@/store/wallet-store'

// ---------------------------------------------------------------------------
// Query key factory — exported so admin actions can invalidate this query
// ---------------------------------------------------------------------------

export const pendingVerificationsKeys = {
  all: ['pending-verifications'] as const,
  page: (cursor: string | null) => ['pending-verifications', cursor] as const,
}

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export interface UsePendingVerificationsResult {
  /** Accumulated list of entries across all loaded pages */
  entries: PendingVerificationEntry[]
  /** True while the first page is loading */
  isLoading: boolean
  /** True while any page is fetching (background or paginating) */
  isFetching: boolean
  /** The error thrown if the fetch failed */
  error: Error | null
  /** True when CONTRACT_IDS.BENEFICIARY_REGISTRY is not configured */
  contractNotConfigured: boolean
  /** True when there are more pages to load */
  hasMore: boolean
  /** Load the next page and append to entries */
  loadMore: () => void
  /** Refetch from page 1, discarding accumulated pages */
  refresh: () => void
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const PAGE_LIMIT = 20

export function usePendingVerifications(): UsePendingVerificationsResult {
  const { network } = useWalletStore()
  const queryClient = useQueryClient()

  // Track accumulated entries and the current cursor across pages
  const [accumulatedEntries, setAccumulatedEntries] = useState<
    PendingVerificationEntry[]
  >([])
  const [currentCursor, setCurrentCursor] = useState<string | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [isLoadingMore, setIsLoadingMore] = useState(false)

  const query = useQuery({
    queryKey: pendingVerificationsKeys.page(null),
    queryFn: async () => {
      const page = await listPendingVerifications(network, null, PAGE_LIMIT)
      setAccumulatedEntries(page.entries)
      setNextCursor(page.nextCursor)
      setCurrentCursor(null)
      return page
    },
    retry: (failureCount, error) => {
      if (error instanceof ContractNotConfiguredError) return false
      return failureCount < 2
    },
  })

  const loadMore = useCallback(async () => {
    if (!nextCursor || isLoadingMore) return

    setIsLoadingMore(true)
    try {
      const page = await listPendingVerifications(network, nextCursor, PAGE_LIMIT)
      setAccumulatedEntries((prev) => [...prev, ...page.entries])
      setCurrentCursor(nextCursor)
      setNextCursor(page.nextCursor)

      // Populate the query cache for this cursor so React Query knows about it
      queryClient.setQueryData(
        pendingVerificationsKeys.page(nextCursor),
        page,
      )
    } catch {
      // silently ignore pagination errors — the existing entries remain visible
    } finally {
      setIsLoadingMore(false)
    }
  }, [nextCursor, isLoadingMore, network, queryClient])

  const refresh = useCallback(() => {
    setAccumulatedEntries([])
    setCurrentCursor(null)
    setNextCursor(null)
    queryClient.invalidateQueries({ queryKey: pendingVerificationsKeys.all })
  }, [queryClient])

  const contractNotConfigured = query.error instanceof ContractNotConfiguredError

  // Suppress unused variable warning — currentCursor tracks pagination state
  void currentCursor

  return {
    entries: accumulatedEntries.length > 0 ? accumulatedEntries : query.data?.entries ?? [],
    isLoading: query.isLoading,
    isFetching: query.isFetching || isLoadingMore,
    error: query.error,
    contractNotConfigured,
    hasMore: nextCursor !== null,
    loadMore,
    refresh,
  }
}
