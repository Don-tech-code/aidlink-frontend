/**
 * Hook-level tests for useDonation's issue #139 fix:
 *  - Optimistic idempotency: two concurrent donate() calls for the same
 *    donor/campaign/amount within the same window must result in exactly
 *    one on-chain submission, and both callers resolve to the same txHash
 *    (Scenario B — double-submit race).
 *  - Silent txBadSeq retry: a sequence-number collision on submission is
 *    retried automatically (re-fetch account, rebuild, re-sign, resubmit)
 *    without ever surfacing an error to the donor (Scenario D).
 *
 * '@stellar/stellar-sdk' is fully mocked here (see src/hooks/__tests__/
 * use-claim.test.tsx for the established pattern in this repo) so these
 * tests exercise the hook's state machine and idempotency bookkeeping in
 * isolation from real XDR encoding — that's covered separately in
 * use-donation-error-decoding.test.ts against the real SDK.
 */

import React from 'react'
import { renderHook, act, waitFor } from '@testing-library/react'

// ── Module mocks must be declared before imports ─────────────────────────────

jest.mock('@/store/wallet-store', () => ({
  useWalletStore: jest.fn(),
}))

jest.mock('@stellar/freighter-api', () => ({
  signTransaction: jest.fn(),
}))

const mockGetAccount = jest.fn()
const mockSimulateTransaction = jest.fn()
const mockSendTransaction = jest.fn()
const mockGetTransaction = jest.fn()
const mockEscrowAddress = 'GESCROWFAKEADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
let mockOuterResultCode = 'txBadSeq'

jest.mock('@stellar/stellar-sdk', () => {
  class FakeAccount {
    constructor(public accountId: string, public sequence: string) {}
  }

  class FakeServer {
    getAccount(...args: unknown[]) {
      return mockGetAccount(...args)
    }
    simulateTransaction(...args: unknown[]) {
      return mockSimulateTransaction(...args)
    }
    sendTransaction(...args: unknown[]) {
      return mockSendTransaction(...args)
    }
    getTransaction(...args: unknown[]) {
      return mockGetTransaction(...args)
    }
  }

  const fakeBuiltTx = { __fakeBuiltTx: true }
  const FakeTransactionBuilderInstance = {
    addOperation: jest.fn().mockReturnThis(),
    setTimeout: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnValue(fakeBuiltTx),
  }
  const FakeTransactionBuilder = jest.fn().mockImplementation(() => FakeTransactionBuilderInstance)
  ;(FakeTransactionBuilder as unknown as { fromXDR: jest.Mock }).fromXDR = jest
    .fn()
    .mockReturnValue({ __fakeSignedTx: true })

  return {
    Account: FakeAccount,
    Asset: { native: jest.fn().mockReturnValue({ __fakeAsset: true }) },
    BASE_FEE: '100',
    Operation: {
      payment: jest.fn().mockReturnValue({ __fakeOp: 'payment' }),
      invokeContractFunction: jest.fn().mockReturnValue({ __fakeOp: 'invoke' }),
    },
    SorobanRpc: {
      Server: FakeServer,
      assembleTransaction: jest.fn().mockReturnValue({
        build: () => ({
          toEnvelope: () => ({ toXDR: () => 'prepared-envelope-xdr' }),
        }),
      }),
      Api: {
        GetTransactionStatus: {
          SUCCESS: 'SUCCESS',
          FAILED: 'FAILED',
          NOT_FOUND: 'NOT_FOUND',
        },
        isSimulationError: jest.fn().mockReturnValue(false),
      },
    },
    TransactionBuilder: FakeTransactionBuilder,
    nativeToScVal: jest.fn(),
    StrKey: { encodeEd25519PublicKey: jest.fn().mockImplementation(() => mockEscrowAddress) },
    xdr: {
      TransactionMeta: { fromXDR: jest.fn() },
      TransactionResult: {
        // Controlled via mockOuterResultCode — jest.mock factories may
        // reference variables prefixed with "mock" (babel-plugin-jest-hoist).
        fromXDR: jest.fn(() => ({
          result: () => ({
            switch: () => ({ name: mockOuterResultCode }),
            results: () => [],
          }),
        })),
      },
    },
  }
})

// Now import after mocks are set up
import { useDonation, __setDonationPollDelayMs, __setSeqRetryBackoffMs, __resetDonationIdempotencyState } from '@/hooks/use-donation'
import { useWalletStore } from '@/store/wallet-store'
import { signTransaction } from '@stellar/freighter-api'

const mockUseWalletStore = useWalletStore as jest.MockedFunction<typeof useWalletStore>
const mockSignTransaction = signTransaction as jest.MockedFunction<typeof signTransaction>

const DONOR_ADDRESS = 'GDONORFAKEADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
const CAMPAIGN_ID = 'camp-idempotency-test'
const TX_HASH_1 = 'a'.repeat(64)
const TX_HASH_2 = 'b'.repeat(64)

function fakeEscrowRetval() {
  return {
    switch: () => ({ name: 'scvAddress' }),
    address: () => ({
      switch: () => ({ name: 'scAddressTypeAccount' }),
      accountId: () => ({ ed25519: () => Buffer.alloc(32) }),
    }),
  }
}

function setupWallet() {
  mockUseWalletStore.mockReturnValue({
    publicKey: DONOR_ADDRESS,
    isConnected: true,
    network: 'testnet',
  } as unknown as ReturnType<typeof useWalletStore>)
}

beforeEach(() => {
  jest.clearAllMocks()
  __setDonationPollDelayMs(0)
  __setSeqRetryBackoffMs(0)
  __resetDonationIdempotencyState()
  setupWallet()

  mockGetAccount.mockResolvedValue({ accountId: () => DONOR_ADDRESS, sequenceNumber: () => '1' })

  // First simulateTransaction call = get_campaign_escrow, second = the main
  // dual-write tx (fee estimation). Both succeed by default.
  mockSimulateTransaction
    .mockResolvedValueOnce({ result: { retval: fakeEscrowRetval() } })
    .mockResolvedValueOnce({ minResourceFee: '5000' })

  mockSignTransaction.mockResolvedValue({ signedTxXdr: 'signed-xdr', signerAddress: DONOR_ADDRESS })
  mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: TX_HASH_1 })
  mockGetTransaction.mockResolvedValue({ status: 'SUCCESS' })
})

afterEach(() => {
  __setDonationPollDelayMs(null)
  __setSeqRetryBackoffMs(null)
})

// ---------------------------------------------------------------------------
// Scenario B — concurrent double-submit is prevented, not just detected
// ---------------------------------------------------------------------------

describe('optimistic idempotency — concurrent donate() calls', () => {
  it('issues exactly one sendTransaction call for two donate(50) calls within 100ms, both resolving to the same hash', async () => {
    const { result } = renderHook(() => useDonation(CAMPAIGN_ID))

    let firstDonatePromise!: Promise<void>
    let secondDonatePromise!: Promise<void>

    act(() => {
      firstDonatePromise = result.current.donate(50)
    })

    await act(async () => {
      // Fire the second call almost immediately — well within the same
      // idempotency window, and before the first call has reached 'polling'.
      await new Promise((r) => setTimeout(r, 10))
    })

    act(() => {
      secondDonatePromise = result.current.donate(50)
    })

    // Let the first call reach awaiting-confirmation, then confirm the fee
    // so the flow proceeds to signing/submission/polling.
    await waitFor(() => {
      expect(result.current.state.status).toBe('awaiting-confirmation')
    })

    act(() => {
      result.current.feeConfirmed()
    })

    await act(async () => {
      await Promise.all([firstDonatePromise, secondDonatePromise])
    })

    expect(mockSendTransaction).toHaveBeenCalledTimes(1)
    expect(result.current.state.status).toBe('success')
    expect(result.current.state.txHash).toBe(TX_HASH_1)
  })

  it('marks the second, deduped call with isDuplicate: true', async () => {
    const { result } = renderHook(() => useDonation(CAMPAIGN_ID))

    let firstDonatePromise!: Promise<void>
    let secondDonatePromise!: Promise<void>

    act(() => {
      firstDonatePromise = result.current.donate(50)
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    act(() => {
      secondDonatePromise = result.current.donate(50)
    })

    await waitFor(() => {
      expect(result.current.state.status).toBe('awaiting-confirmation')
    })

    act(() => {
      result.current.feeConfirmed()
    })

    await act(async () => {
      await Promise.all([firstDonatePromise, secondDonatePromise])
    })

    // Whichever call's resolution is observed last, the hook's state must
    // reflect a successful, deduplicated outcome.
    expect(result.current.state.isDuplicate).toBe(true)
    expect(result.current.state.txHash).toBe(TX_HASH_1)
  })

  it('does not dedupe two calls for different amounts', async () => {
    mockSendTransaction
      .mockResolvedValueOnce({ status: 'PENDING', hash: TX_HASH_1 })
      .mockResolvedValueOnce({ status: 'PENDING', hash: TX_HASH_2 })
    // Two full simulate cycles now (escrow + main, twice)
    mockSimulateTransaction
      .mockReset()
      .mockResolvedValueOnce({ result: { retval: fakeEscrowRetval() } })
      .mockResolvedValueOnce({ minResourceFee: '5000' })
      .mockResolvedValueOnce({ result: { retval: fakeEscrowRetval() } })
      .mockResolvedValueOnce({ minResourceFee: '5000' })

    const { result } = renderHook(() => useDonation(CAMPAIGN_ID))

    act(() => {
      result.current.donate(50)
    })
    await waitFor(() => expect(result.current.state.status).toBe('awaiting-confirmation'))
    act(() => {
      result.current.feeConfirmed()
    })
    await waitFor(() => expect(result.current.state.status).toBe('success'))
    expect(result.current.state.isDuplicate).toBe(false)

    act(() => {
      result.current.donate(75)
    })
    await waitFor(() => expect(result.current.state.status).toBe('awaiting-confirmation'))
    act(() => {
      result.current.feeConfirmed()
    })
    await waitFor(() => expect(result.current.state.status).toBe('success'))

    expect(result.current.state.isDuplicate).toBe(false)
    expect(mockSendTransaction).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// Scenario D — silent txBadSeq retry
// ---------------------------------------------------------------------------

describe('txBadSeq retry-with-backoff', () => {
  it('retries silently on txBadSeq and never surfaces an error to the donor', async () => {
    mockOuterResultCode = 'txBadSeq'
    mockSendTransaction
      .mockResolvedValueOnce({ status: 'ERROR', errorResult: { toXDR: () => 'raw-err-xdr' } })
      .mockResolvedValueOnce({ status: 'PENDING', hash: TX_HASH_1 })

    const { result } = renderHook(() => useDonation(CAMPAIGN_ID))

    act(() => {
      result.current.donate(50)
    })
    await waitFor(() => expect(result.current.state.status).toBe('awaiting-confirmation'))

    act(() => {
      result.current.feeConfirmed()
    })

    await waitFor(() => expect(result.current.state.status).toBe('success'), { timeout: 10_000 })

    expect(result.current.state.error).toBeNull()
    expect(result.current.state.txHash).toBe(TX_HASH_1)
    expect(mockSendTransaction).toHaveBeenCalledTimes(2)
    // Sequence is re-fetched for the retry (initial account + escrow refetch
    // + one more for the seq retry).
    expect(mockGetAccount.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('surfaces a user-visible error after exhausting the max retry attempts', async () => {
    mockOuterResultCode = 'txBadSeq'
    mockSendTransaction.mockResolvedValue({
      status: 'ERROR',
      errorResult: { toXDR: () => 'raw-err-xdr' },
    })

    const { result } = renderHook(() => useDonation(CAMPAIGN_ID))

    act(() => {
      result.current.donate(50)
    })
    await waitFor(() => expect(result.current.state.status).toBe('awaiting-confirmation'))

    act(() => {
      result.current.feeConfirmed()
    })

    await waitFor(() => expect(result.current.state.status).toBe('error'), { timeout: 10_000 })

    expect(result.current.state.error).toContain('Sequence number conflict')
    // 1 initial + 3 retries = 4 total submission attempts
    expect(mockSendTransaction).toHaveBeenCalledTimes(4)
  })

  it('does not retry and surfaces an error immediately for a non-sequence submission error', async () => {
    mockOuterResultCode = 'txInsufficientBalance'
    mockSendTransaction.mockResolvedValue({
      status: 'ERROR',
      errorResult: { toXDR: () => 'raw-err-xdr' },
    })

    const { result } = renderHook(() => useDonation(CAMPAIGN_ID))

    act(() => {
      result.current.donate(50)
    })
    await waitFor(() => expect(result.current.state.status).toBe('awaiting-confirmation'))

    act(() => {
      result.current.feeConfirmed()
    })

    await waitFor(() => expect(result.current.state.status).toBe('error'))

    expect(mockSendTransaction).toHaveBeenCalledTimes(1)
  })
})
