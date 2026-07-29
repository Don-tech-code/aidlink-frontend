/**
 * useDonations(campaignId?) — Donation list + donation tracking
 *
 * trackDonation() delegates the actual blockchain logic to useDonation()
 * so there is a single implementation of the Stellar transaction flow.
 *
 * Fetch donations for a campaign (currently from a mock; replace with an
 * indexer/API call when the backend is available).
 */

import { useState, useEffect, useCallback } from 'react'
import { useDonation, WalletNotConnectedError } from '@/hooks/use-donation'

export interface Donation {
  id: string
  campaignId: string
  donor: string
  amount: number
  timestamp: number
  /** 64-character lowercase hex string, no 0x prefix */
  transactionHash: string
}

export function useDonations(campaignId?: string) {
  const [donations, setDonations] = useState<Donation[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Delegate actual blockchain logic to the canonical hook
  const { state: donationState, donate, feeConfirmed, feeDismissed } = useDonation(
    campaignId ?? '',
  )

  const loadDonations = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      /**
       * TODO (backend): Replace with a real API/indexer call once available, e.g.:
       *   const result = await fetch(`/api/campaigns/${campaignId}/donations`)
       *   const data = await result.json()
       *   setDonations(data)
       *
       * For now we return an empty list — donations submitted via trackDonation()
       * are appended locally until the page reloads (at which point the backend
       * should return them).
       */
      setDonations((prev) => prev) // keep whatever was appended in-session
    } catch (err) {
      setError('Failed to load donations')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }, [campaignId])

  useEffect(() => {
    loadDonations()
  }, [loadDonations])

  /**
   * trackDonation — calls the real Stellar donation flow.
   *
   * IMPORTANT: The caller is responsible for rendering a FeeConfirmationDialog
   * and wiring feeConfirmed/feeDismissed to it. This hook surfaces
   * donationState.status === 'awaiting-confirmation' as the signal to show it.
   */
  const trackDonation = async (
    amount: number,
  ): Promise<{ success: boolean; transactionHash?: string; isDuplicate?: boolean }> => {
    setError(null)
    try {
      await donate(amount)

      if (
        donationState.status === 'success' &&
        donationState.txHash
      ) {
        // Append to local list
        const newDonation: Donation = {
          id: donationState.txHash,
          campaignId: campaignId ?? '',
          donor: 'You',
          amount,
          timestamp: Date.now(),
          transactionHash: donationState.txHash,
        }
        setDonations((prev) => [newDonation, ...prev])
        return {
          success: true,
          transactionHash: donationState.txHash,
          isDuplicate: donationState.isDuplicate,
        }
      }

      // donate() set an error state
      if (donationState.status === 'error') {
        setError(donationState.error ?? 'Donation failed')
        return { success: false }
      }

      return { success: false }
    } catch (err) {
      if (err instanceof WalletNotConnectedError) {
        setError('Please connect your wallet to make a donation')
      } else {
        setError(err instanceof Error ? err.message : 'Donation failed')
      }
      console.error(err)
      return { success: false }
    }
  }

  return {
    donations,
    loading: loading || donationState.status !== 'idle',
    error: error ?? donationState.error,
    trackDonation,
    refresh: loadDonations,
    /** Expose donationState so callers can show the fee dialog */
    donationState,
    feeConfirmed,
    feeDismissed,
  }
}
