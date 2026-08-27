/**
 * Tests for useBalance (issue #86 – AC6).
 *
 * Verifies that useBalance reads the network from useWalletStore and
 * calls getSorobanSDK(network).getBalance() — NOT the deprecated
 * sorobanSDK testnet singleton.
 */

// Hoist the mock for @stellar/stellar-sdk so the real SorobanSDK can be
// constructed without network I/O.  Both SorobanRpc.Server and Horizon.Server
// are replaced with in-memory stubs.
var mockRpcServer = {
  getAccount: jest.fn(),
  simulateTransaction: jest.fn(),
  sendTransaction: jest.fn(),
  getTransaction: jest.fn(),
}

var mockHorizonServer = {
  loadAccount: jest.fn(),
}

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk')
  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: jest.fn().mockImplementation(() => mockRpcServer),
    },
    Horizon: {
      ...actual.Horizon,
      Server: jest.fn().mockImplementation(() => mockHorizonServer),
    },
  }
})

// ---------------------------------------------------------------------------
// Imports — after jest.mock hoisting
// ---------------------------------------------------------------------------

import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useBalance } from '@/hooks/use-contract'
import { useWalletStore } from '@/store/wallet-store'
import {
  getSorobanSDK,
  sorobanSDK,
  __clearSorobanSDKCache,
} from '@/lib/soroban/sdk'

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useBalance — AC6: uses getSorobanSDK(network), not sorobanSDK singleton', () => {
  let queryClient: QueryClient
  let getBalanceSpy: jest.SpyInstance

  beforeEach(() => {
    __clearSorobanSDKCache()
    jest.clearAllMocks()

    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: 0,
          gcTime: 0,
        },
      },
    })

    // Pre-warm the SDK cache for testnet so we can spy on the instance
    // that useBalance will receive from getSorobanSDK('testnet').
    const sdk = getSorobanSDK('testnet')
    getBalanceSpy = jest.spyOn(sdk, 'getBalance')

    useWalletStore.setState({ network: 'testnet' })
  })

  afterEach(() => {
    queryClient.clear()
    getBalanceSpy?.mockRestore()
  })

  it('calls getSorobanSDK with the network from the wallet store (testnet)', async () => {
    useWalletStore.setState({ network: 'testnet' })
    getBalanceSpy.mockResolvedValue('100.0000000')

    renderHook(() => useBalance('GABC123'), { wrapper: wrapper(queryClient) })

    // Wait for the query to attempt to fetch
    await waitFor(() => expect(getBalanceSpy).toHaveBeenCalled())

    // The SDK instance in cache is for testnet — confirmed by its passphrase.
    expect(getSorobanSDK('testnet').networkPassphrase).toBe('Test SDF Network ; September 2015')
  })

  it('calls getSorobanSDK with mainnet when wallet store is on mainnet', async () => {
    __clearSorobanSDKCache()
    useWalletStore.setState({ network: 'mainnet' })

    const mainnetSdk = getSorobanSDK('mainnet')
    const mainnetSpy = jest.spyOn(mainnetSdk, 'getBalance').mockResolvedValue('50.0000000')

    renderHook(() => useBalance('GABC123'), { wrapper: wrapper(queryClient) })

    await waitFor(() => expect(mainnetSpy).toHaveBeenCalled())

    mainnetSpy.mockRestore()
  })

  it('returns the balance from getSorobanSDK(network).getBalance()', async () => {
    getBalanceSpy.mockResolvedValue('9999.9999800')

    const { result } = renderHook(() => useBalance('GABC123'), { wrapper: wrapper(queryClient) })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data).toBe('9999.9999800')
  })

  it('passes the accountId to getBalance', async () => {
    getBalanceSpy.mockResolvedValue('0.0000000')

    renderHook(() => useBalance('GSPECIFICADDRESS'), { wrapper: wrapper(queryClient) })

    await waitFor(() => expect(getBalanceSpy).toHaveBeenCalledWith('GSPECIFICADDRESS'))
  })

  it('includes network in the query key so different networks are cached separately', async () => {
    getBalanceSpy.mockResolvedValue('10.0000000')

    const { result } = renderHook(() => useBalance('GABC123'), { wrapper: wrapper(queryClient) })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const cacheKeys = queryClient
      .getQueryCache()
      .findAll()
      .map((q) => q.queryKey)

    const balanceQuery = cacheKeys.find(
      (k) => Array.isArray(k) && k[0] === 'balance'
    )
    expect(balanceQuery).toBeDefined()
    // The query key must contain the network string so different networks
    // are cached separately and don't serve stale cross-network data.
    expect(balanceQuery).toContain('testnet')
  })

  it('does NOT call the deprecated sorobanSDK singleton directly', async () => {
    getBalanceSpy.mockResolvedValue('0.0000000')
    const singletonSpy = jest.spyOn(sorobanSDK, 'getBalance')

    renderHook(() => useBalance('GABC123'), { wrapper: wrapper(queryClient) })
    await waitFor(() => expect(getBalanceSpy).toHaveBeenCalled())

    // The singleton's getBalance must NOT have been called.
    expect(singletonSpy).not.toHaveBeenCalled()

    singletonSpy.mockRestore()
  })

  it('does not fetch when accountId is null', () => {
    renderHook(() => useBalance(null), { wrapper: wrapper(queryClient) })

    // No queries should have been issued — the `enabled: !!accountId` guard.
    expect(getBalanceSpy).not.toHaveBeenCalled()
  })
})
