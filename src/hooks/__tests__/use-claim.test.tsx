/**
 * Unit tests for src/hooks/use-claim.ts
 *
 * Coverage:
 *  - Initial state is 'idle'
 *  - startClaim with no wallet → error state
 *  - Token expiry gating: expired token → token-expired (no RPC call)
 *  - Token wrong-address → not-your-claim (no RPC call)
 *  - Happy path: idle → fetching-fee → awaiting-confirmation (fee displayed)
 *  - feeDismissed: resets to idle, no signing
 *  - feeConfirmed happy path: → signing → submitting → polling → success (64-char hash)
 *  - Already-claimed error from simulateClaim → already-claimed state
 *  - On-chain FAILED result → error state
 *  - Polling with exponential backoff resolves to success
 *  - Wallet cancel during signing → idle (no submission)
 *  - reset() always returns to idle
 */

import React from 'react'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// ── Module mocks must be declared before imports ─────────────────────────────

// Mock the wallet store
jest.mock('@/store/wallet-store', () => ({
  useWalletStore: jest.fn(),
}))

// Mock claim token functions
jest.mock('@/lib/beneficiary/claim-token', () => ({
  validateClaimToken: jest.fn(),
  isTokenExpiredSync: jest.fn(),
  stroopsToXlm: (s: number | bigint | string) => Number(s) / 10_000_000,
  formatClaimFeeXlm: (xlm: number) => `${xlm.toFixed(7)} XLM`,
}))

// Mock allocations (simulateClaim)
jest.mock('@/lib/beneficiary/allocations', () => {
  const actual = jest.requireActual('@/lib/beneficiary/allocations')
  return {
    ...actual,
    simulateClaim: jest.fn(),
  }
})

// Mock Freighter
jest.mock('@stellar/freighter-api', () => ({
  signTransaction: jest.fn(),
}))

// Shared mock functions for the RPC server — every FakeServer instance delegates
// to these module-level mocks so tests can configure them in beforeEach/it blocks.
const mockSendTransaction = jest.fn()
const mockGetTransaction = jest.fn()

// Mock stellar-sdk TransactionBuilder.fromXDR and SorobanRpc.Server
jest.mock('@stellar/stellar-sdk', () => {
  class FakeServer {
    sendTransaction(...args: unknown[]) { return mockSendTransaction(...args) }
    getTransaction(...args: unknown[]) { return mockGetTransaction(...args) }
  }

  const FakeTransactionBuilder = {
    fromXDR: jest.fn().mockReturnValue({ toXDR: () => 'fake-xdr' }),
  }

  return {
    BASE_FEE: '100',
    Operation: { invokeContractFunction: jest.fn() },
    SorobanRpc: {
      Server: FakeServer,
      Api: {
        GetTransactionStatus: {
          SUCCESS: 'SUCCESS',
          FAILED: 'FAILED',
          NOT_FOUND: 'NOT_FOUND',
        },
        isSimulationError: jest.fn().mockReturnValue(false),
        isSimulationSuccess: jest.fn().mockReturnValue(true),
        assembleTransaction: jest.fn(),
      },
    },
    TransactionBuilder: FakeTransactionBuilder,
    nativeToScVal: jest.fn(),
    xdr: { ScVal: { scvVoid: () => ({}) } },
  }
})

// Now import after mocks are set up
import { useClaim, __setPollDelayMs } from '@/hooks/use-claim'
import { useWalletStore } from '@/store/wallet-store'
import { validateClaimToken, isTokenExpiredSync } from '@/lib/beneficiary/claim-token'
import { simulateClaim, AlreadyClaimedError } from '@/lib/beneficiary/allocations'
import { signTransaction } from '@stellar/freighter-api'
import { TransactionBuilder } from '@stellar/stellar-sdk'
import type { Allocation } from '@/types'

// ── Helpers ─────────────────────────────────────────────────────────────────

const mockUseWalletStore = useWalletStore as jest.MockedFunction<typeof useWalletStore>
const mockValidateClaimToken = validateClaimToken as jest.MockedFunction<typeof validateClaimToken>
const mockIsTokenExpiredSync = isTokenExpiredSync as jest.MockedFunction<typeof isTokenExpiredSync>
const mockSimulateClaim = simulateClaim as jest.MockedFunction<typeof simulateClaim>
const mockSignTransaction = signTransaction as jest.MockedFunction<typeof signTransaction>

const WALLET_ADDRESS = 'GDQOE23CFSUMSVQK4Y5JHPPYK73VYCNHZHA7ENKCV37P6SUEO6XQBKPP'
const VALID_TX_HASH = 'a'.repeat(64)

const mockAllocation: Allocation = {
  claimId: 'claim-001',
  campaignId: 'camp-001',
  campaignName: 'Test Campaign',
  allocatedAmountStroops: BigInt(100_000_000),
  isClaimed: false,
  createdAt: new Date().toISOString(),
}

const MOCK_TOKEN = 'mock-claim-token'

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

function setupWallet(connected = true) {
  mockUseWalletStore.mockReturnValue({
    address: connected ? WALLET_ADDRESS : null,
    isConnected: connected,
    network: 'testnet',
  } as ReturnType<typeof useWalletStore>)
}

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks()
  // Make polling instant so tests don't wait seconds
  __setPollDelayMs(0)
  setupWallet()
  // Default: token is fresh and valid for this wallet
  mockIsTokenExpiredSync.mockReturnValue(false)
  mockValidateClaimToken.mockResolvedValue({
    valid: true,
    payload: {
      claimId: 'claim-001',
      beneficiaryAddress: WALLET_ADDRESS,
      campaignId: 'camp-001',
      allocatedAmount: '100000000',
      exp: Math.floor(Date.now() / 1000) + 900,
      sig: 'a'.repeat(64),
    },
  })
  mockSimulateClaim.mockResolvedValue({
    feeStroops: BigInt(1234),
    preparedTxXdr: 'prepared-xdr-base64',
  })
  mockSignTransaction.mockResolvedValue({ signedTxXdr: 'signed-xdr-base64', signerAddress: WALLET_ADDRESS })
  ;(TransactionBuilder.fromXDR as jest.Mock).mockReturnValue({ toXDR: () => '' })
})

afterEach(() => {
  __setPollDelayMs(null) // restore real delays
})

// ── Initial state ─────────────────────────────────────────────────────────────

describe('initial state', () => {
  it('starts in idle with null fee, hash, and error', () => {
    const { result } = renderHook(
      () => useClaim(mockAllocation, MOCK_TOKEN),
      { wrapper },
    )
    expect(result.current.state.status).toBe('idle')
    expect(result.current.state.estimatedFeeXlm).toBeNull()
    expect(result.current.state.txHash).toBeNull()
    expect(result.current.state.error).toBeNull()
  })
})

// ── Wallet not connected ──────────────────────────────────────────────────────

describe('wallet not connected', () => {
  it('transitions to error when startClaim is called without a wallet', async () => {
    setupWallet(false)
    const { result } = renderHook(
      () => useClaim(mockAllocation, MOCK_TOKEN),
      { wrapper },
    )

    await act(async () => { await result.current.startClaim() })

    expect(result.current.state.status).toBe('error')
    expect(result.current.state.error).toMatch(/wallet/i)
    expect(mockSimulateClaim).not.toHaveBeenCalled()
  })
})

// ── Token expiry gating ───────────────────────────────────────────────────────

describe('token expiry gating', () => {
  it('transitions to token-expired when isTokenExpiredSync returns true', async () => {
    mockIsTokenExpiredSync.mockReturnValue(true)

    const { result } = renderHook(
      () => useClaim(mockAllocation, MOCK_TOKEN),
      { wrapper },
    )

    await act(async () => { await result.current.startClaim() })

    expect(result.current.state.status).toBe('token-expired')
    expect(result.current.state.error).toMatch(/expired/i)
    // Must not reach the contract
    expect(mockSimulateClaim).not.toHaveBeenCalled()
  })

  it('transitions to token-expired when validateClaimToken returns expired', async () => {
    mockIsTokenExpiredSync.mockReturnValue(false)
    mockValidateClaimToken.mockResolvedValue({
      valid: false,
      reason: 'expired',
      message: 'This claim token has expired. Refresh the page for a new one.',
    })

    const { result } = renderHook(
      () => useClaim(mockAllocation, MOCK_TOKEN),
      { wrapper },
    )

    await act(async () => { await result.current.startClaim() })

    expect(result.current.state.status).toBe('token-expired')
    expect(result.current.state.error).toMatch(/expired/i)
    expect(mockSimulateClaim).not.toHaveBeenCalled()
  })
})

// ── Wrong wallet ──────────────────────────────────────────────────────────────

describe('wrong wallet address', () => {
  it('transitions to not-your-claim when validateClaimToken returns wrong-address', async () => {
    mockValidateClaimToken.mockResolvedValue({
      valid: false,
      reason: 'wrong-address',
      message: 'This claim token is not for the connected wallet.',
    })

    const { result } = renderHook(
      () => useClaim(mockAllocation, MOCK_TOKEN),
      { wrapper },
    )

    await act(async () => { await result.current.startClaim() })

    expect(result.current.state.status).toBe('not-your-claim')
    expect(result.current.state.error).toMatch(/wallet/i)
    expect(mockSimulateClaim).not.toHaveBeenCalled()
  })
})

// ── Fee estimation ────────────────────────────────────────────────────────────

describe('fee estimation', () => {
  it('transitions to awaiting-confirmation with estimatedFeeXlm after simulateClaim', async () => {
    // 1_234 stroops → 0.0001234 XLM
    mockSimulateClaim.mockResolvedValue({
      feeStroops: BigInt(1_234),
      preparedTxXdr: 'prepared-xdr',
    })

    const { result } = renderHook(
      () => useClaim(mockAllocation, MOCK_TOKEN),
      { wrapper },
    )

    await act(async () => { await result.current.startClaim() })

    expect(result.current.state.status).toBe('awaiting-confirmation')
    expect(result.current.state.estimatedFeeXlm).toBeCloseTo(1234 / 10_000_000, 7)
    expect(mockSimulateClaim).toHaveBeenCalledWith(
      mockAllocation.claimId,
      WALLET_ADDRESS,
      'testnet',
    )
  })
})

// ── Fee dialog cancel ─────────────────────────────────────────────────────────

describe('feeDismissed', () => {
  it('resets to idle when the user cancels the fee dialog, no signing occurs', async () => {
    const { result } = renderHook(
      () => useClaim(mockAllocation, MOCK_TOKEN),
      { wrapper },
    )

    await act(async () => { await result.current.startClaim() })
    expect(result.current.state.status).toBe('awaiting-confirmation')

    act(() => { result.current.feeDismissed() })

    expect(result.current.state.status).toBe('idle')
    expect(mockSignTransaction).not.toHaveBeenCalled()
  })
})

// ── Happy path: full flow to success ─────────────────────────────────────────

describe('happy path — full claim flow', () => {
  it('progresses through signing → submitting → polling → success with a 64-char hex txHash', async () => {
    // sendTransaction returns PENDING
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: VALID_TX_HASH })
    // First poll: NOT_FOUND; second poll: SUCCESS
    mockGetTransaction
      .mockResolvedValueOnce({ status: 'NOT_FOUND' })
      .mockResolvedValueOnce({ status: 'SUCCESS' })

    const { result } = renderHook(
      () => useClaim(mockAllocation, MOCK_TOKEN),
      { wrapper },
    )

    // Step 1 — get to awaiting-confirmation
    await act(async () => { await result.current.startClaim() })
    expect(result.current.state.status).toBe('awaiting-confirmation')

    // Step 2 — confirm fee (triggers async signing + submit + poll)
    await act(async () => { await result.current.feeConfirmed() })

    await waitFor(() => {
      expect(result.current.state.status).toBe('success')
    }, { timeout: 30_000 })

    expect(result.current.state.txHash).toBe(VALID_TX_HASH)
    // Acceptance criterion: hash must match /^[a-f0-9]{64}$/i
    expect(result.current.state.txHash).toMatch(/^[a-f0-9]{64}$/i)
    expect(result.current.state.error).toBeNull()
  })
})

// ── Already claimed ───────────────────────────────────────────────────────────

describe('already-claimed error', () => {
  it('shows already-claimed state when simulateClaim throws AlreadyClaimedError', async () => {
    mockSimulateClaim.mockRejectedValue(new AlreadyClaimedError('claim-001'))

    const { result } = renderHook(
      () => useClaim(mockAllocation, MOCK_TOKEN),
      { wrapper },
    )

    await act(async () => { await result.current.startClaim() })

    expect(result.current.state.status).toBe('already-claimed')
    expect(result.current.state.error).toMatch(/already claimed/i)
    expect(mockSignTransaction).not.toHaveBeenCalled()
  })
})

// ── On-chain FAILED ───────────────────────────────────────────────────────────

describe('on-chain failure', () => {
  it('shows error state when the transaction is FAILED on-chain', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: VALID_TX_HASH })
    mockGetTransaction.mockResolvedValue({
      status: 'FAILED',
      resultXdr: { toXDR: () => Buffer.alloc(0) },
    })

    const { result } = renderHook(
      () => useClaim(mockAllocation, MOCK_TOKEN),
      { wrapper },
    )

    await act(async () => { await result.current.startClaim() })
    await act(async () => { await result.current.feeConfirmed() })

    await waitFor(() => {
      expect(['error', 'already-claimed']).toContain(result.current.state.status)
    }, { timeout: 30_000 })

    expect(result.current.state.txHash).toBeNull()
  })
})

// ── Wallet cancel ─────────────────────────────────────────────────────────────

describe('wallet signing cancelled', () => {
  it('resets to idle when the user cancels in Freighter', async () => {
    mockSignTransaction.mockRejectedValue(new Error('User declined the request'))

    const { result } = renderHook(
      () => useClaim(mockAllocation, MOCK_TOKEN),
      { wrapper },
    )

    await act(async () => { await result.current.startClaim() })
    await act(async () => { await result.current.feeConfirmed() })

    await waitFor(() => {
      expect(result.current.state.status).toBe('idle')
    })

    expect(result.current.state.txHash).toBeNull()
  })
})

// ── reset() ───────────────────────────────────────────────────────────────────

describe('reset()', () => {
  it('returns to idle from any error state', async () => {
    mockSimulateClaim.mockRejectedValue(new Error('network error'))

    const { result } = renderHook(
      () => useClaim(mockAllocation, MOCK_TOKEN),
      { wrapper },
    )

    await act(async () => { await result.current.startClaim() })
    expect(result.current.state.status).toBe('error')

    act(() => { result.current.reset() })
    expect(result.current.state.status).toBe('idle')
    expect(result.current.state.error).toBeNull()
  })

  it('returns to idle from token-expired', async () => {
    mockIsTokenExpiredSync.mockReturnValue(true)

    const { result } = renderHook(
      () => useClaim(mockAllocation, MOCK_TOKEN),
      { wrapper },
    )

    await act(async () => { await result.current.startClaim() })
    expect(result.current.state.status).toBe('token-expired')

    act(() => { result.current.reset() })
    expect(result.current.state.status).toBe('idle')
  })
})

// ── Polling with backoff ──────────────────────────────────────────────────────

describe('polling with exponential backoff', () => {
  it('keeps polling through NOT_FOUND until SUCCESS', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: VALID_TX_HASH })
    // Return NOT_FOUND twice, then SUCCESS on the third call
    mockGetTransaction
      .mockResolvedValueOnce({ status: 'NOT_FOUND' })
      .mockResolvedValueOnce({ status: 'NOT_FOUND' })
      .mockResolvedValueOnce({ status: 'SUCCESS' })

    const { result } = renderHook(
      () => useClaim(mockAllocation, MOCK_TOKEN),
      { wrapper },
    )

    await act(async () => { await result.current.startClaim() })
    expect(result.current.state.status).toBe('awaiting-confirmation')

    await act(async () => { await result.current.feeConfirmed() })

    await waitFor(() => {
      expect(result.current.state.status).toBe('success')
    }, { timeout: 5_000 })

    // All three getTransaction calls should have been made
    expect(mockGetTransaction).toHaveBeenCalledTimes(3)
  })
})

// ── Fee display formatting ────────────────────────────────────────────────────

describe('fee display formatting in state', () => {
  it('estimatedFeeXlm is correct for a given feeStroops value', async () => {
    const feeStroops = BigInt(5_000_000) // 0.5 XLM
    mockSimulateClaim.mockResolvedValue({ feeStroops, preparedTxXdr: 'xdr' })

    const { result } = renderHook(
      () => useClaim(mockAllocation, MOCK_TOKEN),
      { wrapper },
    )

    await act(async () => { await result.current.startClaim() })

    expect(result.current.state.estimatedFeeXlm).toBeCloseTo(0.5, 7)
  })
})
