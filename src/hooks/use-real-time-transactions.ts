'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Horizon } from '@stellar/stellar-sdk'
import { useNotificationStore } from '@/store/notification-store'
import { useWalletStore } from '@/store/wallet-store'
import { computeBackoffMs } from '@/lib/horizon/backoff'
import { BoundedFifoSet } from '@/lib/horizon/bounded-fifo-set'
import {
  decodeHorizonTransaction,
  type HorizonTransactionRecord,
  type RealtimeTransaction,
} from '@/lib/horizon/decode-horizon-transaction'
import {
  cursorStorageKey,
  getHorizonUrl,
  type HorizonNetwork,
} from '@/lib/horizon/network'

/** @deprecated Prefer RealtimeTransaction — kept for existing imports. */
export type Transaction = RealtimeTransaction

export interface UseRealTimeTransactionsResult {
  transactions: RealtimeTransaction[]
  isConnected: boolean
  error: string | null
}

export const MAX_VISIBLE_TRANSACTIONS = 50
export const DEDUPE_CAPACITY = 200

function readCursor(publicKey: string, network: HorizonNetwork): string {
  if (typeof sessionStorage === 'undefined') {
    return 'now'
  }
  return sessionStorage.getItem(cursorStorageKey(publicKey, network)) || 'now'
}

function writeCursor(
  publicKey: string,
  network: HorizonNetwork,
  cursor: string
): void {
  if (typeof sessionStorage === 'undefined') {
    return
  }
  sessionStorage.setItem(cursorStorageKey(publicKey, network), cursor)
}

function clearCursor(publicKey: string, network: HorizonNetwork): void {
  if (typeof sessionStorage === 'undefined') {
    return
  }
  sessionStorage.removeItem(cursorStorageKey(publicKey, network))
}

/**
 * Live Horizon SSE stream of account transactions.
 *
 * Replaces the previous setInterval simulation with:
 * - Horizon.Server(...).transactions().forAccount(...).stream(...)
 * - sessionStorage cursor persistence
 * - exponential backoff reconnect with jitter
 * - bounded txHash deduplication
 * - payment + Soroban invokeHostFunction decoding
 */
export function useRealTimeTransactions(
  initialTransactions: RealtimeTransaction[] = []
): UseRealTimeTransactionsResult {
  const publicKey = useWalletStore((s) => s.publicKey ?? s.address)
  const network = useWalletStore((s) => s.network)
  const walletConnected = useWalletStore((s) => s.isConnected)

  const addNotification = useNotificationStore((s) => s.addNotification)

  const [transactions, setTransactions] =
    useState<RealtimeTransaction[]>(initialTransactions)
  const [isConnected, setIsConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const seenRef = useRef(new BoundedFifoSet(DEDUPE_CAPACITY))
  const attemptRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeStreamRef = useRef<(() => void) | null>(null)
  const closedRef = useRef(false)

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
  }, [])

  const stopStream = useCallback(() => {
    clearReconnectTimer()
    if (closeStreamRef.current) {
      closeStreamRef.current()
      closeStreamRef.current = null
    }
    setIsConnected(false)
  }, [clearReconnectTimer])

  useEffect(() => {
    closedRef.current = false

    if (!walletConnected || !publicKey) {
      stopStream()
      setTransactions(initialTransactions)
      setError(null)
      seenRef.current.clear()
      attemptRef.current = 0
      return () => {
        closedRef.current = true
        stopStream()
      }
    }

    const horizonUrl = getHorizonUrl(network)

    const handleTransaction = (record: HorizonTransactionRecord) => {
      if (closedRef.current) return

      attemptRef.current = 0
      setIsConnected(true)
      setError(null)

      const dedupeKey = record.hash || record.paging_token
      if (!dedupeKey || !seenRef.current.add(dedupeKey)) {
        return
      }

      if (record.paging_token) {
        writeCursor(publicKey, network, record.paging_token)
      }

      const decoded = decodeHorizonTransaction(record, publicKey)
      if (decoded.length === 0) {
        return
      }

      setTransactions((prev) =>
        [...decoded, ...prev].slice(0, MAX_VISIBLE_TRANSACTIONS)
      )

      for (const tx of decoded) {
        addNotification({
          type: 'transaction',
          title: `New ${tx.type}`,
          message: `${tx.amount} XLM ${
            tx.type === 'donation' ? 'received' : 'recorded'
          } (${tx.to})`,
        })
      }
    }

    const openStream = () => {
      if (closedRef.current) return

      stopStream()

      try {
        const server = new Horizon.Server(horizonUrl, {
          allowHttp: network === 'standalone',
        })
        const cursor = readCursor(publicKey, network)

        const close = server
          .transactions()
          .forAccount(publicKey)
          .cursor(cursor)
          .stream({
            onmessage: (message) => {
              // Runtime SSE payloads are individual TransactionRecord objects,
              // even though the CallBuilder generic is a collection page.
              handleTransaction(message as unknown as HorizonTransactionRecord)
            },
            onerror: (event) => {
              if (closedRef.current) return

              setIsConnected(false)
              setError('Horizon transaction stream disconnected')

              if (closeStreamRef.current) {
                closeStreamRef.current()
                closeStreamRef.current = null
              }

              const delay = computeBackoffMs(attemptRef.current)
              attemptRef.current += 1

              clearReconnectTimer()
              reconnectTimerRef.current = setTimeout(() => {
                if (!closedRef.current) {
                  openStream()
                }
              }, delay)

              // Avoid unhandled noisy event objects in tests/devtools.
              void event
            },
          })

        closeStreamRef.current = close
        setIsConnected(true)
        setError(null)
      } catch (err) {
        setIsConnected(false)
        setError(
          err instanceof Error
            ? err.message
            : 'Failed to open Horizon transaction stream'
        )

        const delay = computeBackoffMs(attemptRef.current)
        attemptRef.current += 1
        clearReconnectTimer()
        reconnectTimerRef.current = setTimeout(() => {
          if (!closedRef.current) {
            openStream()
          }
        }, delay)
      }
    }

    openStream()

    return () => {
      closedRef.current = true
      stopStream()
    }
    // initialTransactions is only a seed for the disconnected/empty state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    walletConnected,
    publicKey,
    network,
    addNotification,
    stopStream,
    clearReconnectTimer,
  ])

  // When the wallet disconnects, drop the session cursor for this account/network
  // so the next session starts from `now` rather than a stale token.
  useEffect(() => {
    if (!walletConnected && publicKey) {
      clearCursor(publicKey, network)
    }
  }, [walletConnected, publicKey, network])

  return {
    transactions,
    isConnected,
    error,
  }
}
