/**
 * Unit tests for useRealTimeTransactions (issue #87).
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import {
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  Account,
} from '@stellar/stellar-sdk'
import { useRealTimeTransactions } from '@/hooks/use-real-time-transactions'
import { useWalletStore } from '@/store/wallet-store'
import { useNotificationStore } from '@/store/notification-store'
import { cursorStorageKey } from '@/lib/horizon/network'
import { NETWORKS } from '@/config/constants'

type StreamHandlers = {
  onmessage?: (value: unknown) => void
  onerror?: (event: MessageEvent) => void
}

type StreamCall = {
  publicKey: string
  cursor: string
  horizonUrl: string
  close: jest.Mock
  handlers: StreamHandlers
}

const streamCalls: StreamCall[] = []

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk')

  class MockServer {
    url: string
    constructor(url: string) {
      this.url = url
    }

    transactions() {
      const server = this
      let accountId = ''
      let cursorValue = 'now'

      const builder = {
        forAccount(id: string) {
          accountId = id
          return builder
        },
        cursor(value: string) {
          cursorValue = value
          return builder
        },
        stream(handlers: StreamHandlers = {}) {
          const close = jest.fn()
          streamCalls.push({
            publicKey: accountId,
            cursor: cursorValue,
            horizonUrl: server.url,
            close,
            handlers,
          })
          return close
        },
      }

      return builder
    }
  }

  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: MockServer,
    },
  }
})

function buildPaymentEnvelopeXdr(params: {
  source: Keypair
  destination: Keypair
  amount: string
}): string {
  const account = new Account(params.source.publicKey(), '1')
  const tx = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: params.destination.publicKey(),
        asset: Asset.native(),
        amount: params.amount,
      })
    )
    .setTimeout(30)
    .build()

  return tx.toEnvelope().toXDR('base64')
}

function makeTxRecord(overrides: Partial<Horizon.ServerApi.TransactionRecord> & {
  hash: string
  paging_token: string
  source_account: string
  envelope_xdr: string
}): Horizon.ServerApi.TransactionRecord {
  return {
    successful: true,
    created_at: '2026-07-23T12:00:00Z',
    ...overrides,
  } as Horizon.ServerApi.TransactionRecord
}

function resetStores(publicKey: string | null, network: 'testnet' | 'mainnet' = 'testnet') {
  useWalletStore.setState({
    isConnected: Boolean(publicKey),
    address: publicKey,
    publicKey,
    network,
    balance: '100',
  })
  useNotificationStore.setState({
    notifications: [],
    unreadCount: 0,
  })
  sessionStorage.clear()
  streamCalls.length = 0
}

describe('useRealTimeTransactions', () => {
  const source = Keypair.random()
  const destination = Keypair.random()

  beforeEach(() => {
    jest.useRealTimers()
    resetStores(source.publicKey(), 'testnet')
  })

  afterEach(() => {
    jest.useRealTimers()
    const latest = streamCalls[streamCalls.length - 1]
    latest?.close?.mockClear?.()
  })

  it('emits 3 decoded transactions in reverse-chronological order', async () => {
    const { result } = renderHook(() => useRealTimeTransactions([]))

    await waitFor(() => expect(streamCalls.length).toBeGreaterThan(0))
    const stream = streamCalls[0]

    const records = [1, 2, 3].map((n) =>
      makeTxRecord({
        hash: `hash-${n}`,
        paging_token: `cursor-${n}`,
        source_account: destination.publicKey(),
        envelope_xdr: buildPaymentEnvelopeXdr({
          source: destination,
          destination: source,
          amount: String(n * 10),
        }),
      })
    )

    act(() => {
      for (const record of records) {
        stream.handlers.onmessage?.(record)
      }
    })

    await waitFor(() => {
      expect(result.current.transactions).toHaveLength(3)
    })

    expect(result.current.transactions.map((t) => t.txHash)).toEqual([
      'hash-3',
      'hash-2',
      'hash-1',
    ])
    expect(result.current.transactions[0].type).toBe('donation')
    expect(result.current.isConnected).toBe(true)
  })

  it('deduplicates when the same paging_token / hash is emitted twice', async () => {
    const { result } = renderHook(() => useRealTimeTransactions([]))
    await waitFor(() => expect(streamCalls.length).toBeGreaterThan(0))
    const stream = streamCalls[0]

    const record = makeTxRecord({
      hash: 'dup-hash',
      paging_token: 'dup-cursor',
      source_account: destination.publicKey(),
      envelope_xdr: buildPaymentEnvelopeXdr({
        source: destination,
        destination: source,
        amount: '5',
      }),
    })

    act(() => {
      stream.handlers.onmessage?.(record)
      stream.handlers.onmessage?.(record)
    })

    await waitFor(() => {
      expect(result.current.transactions).toHaveLength(1)
    })
  })

  it('caps visible transactions at 50 (FIFO)', async () => {
    const { result } = renderHook(() => useRealTimeTransactions([]))
    await waitFor(() => expect(streamCalls.length).toBeGreaterThan(0))
    const stream = streamCalls[0]

    act(() => {
      for (let i = 0; i < 60; i += 1) {
        stream.handlers.onmessage?.(
          makeTxRecord({
            hash: `hash-${i}`,
            paging_token: `cursor-${i}`,
            source_account: destination.publicKey(),
            envelope_xdr: buildPaymentEnvelopeXdr({
              source: destination,
              destination: source,
              amount: '1',
            }),
          })
        )
      }
    })

    await waitFor(() => {
      expect(result.current.transactions).toHaveLength(50)
    })
    expect(result.current.transactions[0].txHash).toBe('hash-59')
    expect(
      result.current.transactions.some((t) => t.txHash === 'hash-0')
    ).toBe(false)
  })

  it('reconnects with backoff after onerror using the last cursor', async () => {
    jest.useFakeTimers()
    const { result } = renderHook(() => useRealTimeTransactions([]))

    await act(async () => {
      await Promise.resolve()
    })
    expect(streamCalls.length).toBe(1)

    const first = streamCalls[0]
    act(() => {
      first.handlers.onmessage?.(
        makeTxRecord({
          hash: 'hash-cursor',
          paging_token: 'saved-cursor',
          source_account: destination.publicKey(),
          envelope_xdr: buildPaymentEnvelopeXdr({
            source: destination,
            destination: source,
            amount: '1',
          }),
        })
      )
    })

    expect(sessionStorage.getItem(cursorStorageKey(source.publicKey(), 'testnet'))).toBe(
      'saved-cursor'
    )

    act(() => {
      first.handlers.onerror?.(new MessageEvent('error'))
    })

    expect(result.current.isConnected).toBe(false)
    expect(first.close).toHaveBeenCalled()

    // attempt 0 → ≈1s (±50%). Advance past the upper bound.
    await act(async () => {
      jest.advanceTimersByTime(1600)
      await Promise.resolve()
    })

    expect(streamCalls.length).toBe(2)
    expect(streamCalls[1].cursor).toBe('saved-cursor')

    act(() => {
      streamCalls[1].handlers.onerror?.(new MessageEvent('error'))
    })

    // attempt 1 → ≈2s
    await act(async () => {
      jest.advanceTimersByTime(3100)
      await Promise.resolve()
    })
    expect(streamCalls.length).toBe(3)

    act(() => {
      streamCalls[2].handlers.onerror?.(new MessageEvent('error'))
    })

    // attempt 2 → ≈4s
    await act(async () => {
      jest.advanceTimersByTime(6100)
      await Promise.resolve()
    })
    expect(streamCalls.length).toBe(4)
  })

  it('calls stream close() exactly once on unmount', async () => {
    const { unmount } = renderHook(() => useRealTimeTransactions([]))
    await waitFor(() => expect(streamCalls.length).toBeGreaterThan(0))
    const close = streamCalls[0].close

    unmount()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes the stream when the wallet disconnects', async () => {
    const { result } = renderHook(() => useRealTimeTransactions([]))
    await waitFor(() => expect(streamCalls.length).toBeGreaterThan(0))
    const close = streamCalls[0].close

    act(() => {
      useWalletStore.getState().disconnect()
    })

    await waitFor(() => {
      expect(close).toHaveBeenCalled()
      expect(result.current.isConnected).toBe(false)
    })
  })

  it('reopens against mainnet Horizon when the wallet network changes', async () => {
    const { rerender } = renderHook(() => useRealTimeTransactions([]))
    await waitFor(() => expect(streamCalls.length).toBe(1))
    expect(streamCalls[0].horizonUrl).toBe(NETWORKS.TESTNET)

    const firstClose = streamCalls[0].close

    act(() => {
      useWalletStore.getState().switchNetwork('mainnet')
    })
    rerender()

    await waitFor(() => expect(streamCalls.length).toBe(2))
    expect(firstClose).toHaveBeenCalled()
    expect(streamCalls[1].horizonUrl).toBe(NETWORKS.MAINNET)
    expect(streamCalls[1].horizonUrl).toBe('https://horizon.stellar.org')
  })

  it('does not contain Math.random in the hook source', () => {
    // Soft guard mirroring the issue acceptance criteria (also enforced by review).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path')
    const sourceText = fs.readFileSync(
      path.join(process.cwd(), 'src/hooks/use-real-time-transactions.ts'),
      'utf8'
    )
    expect(sourceText.includes('Math.random')).toBe(false)
  })
})
