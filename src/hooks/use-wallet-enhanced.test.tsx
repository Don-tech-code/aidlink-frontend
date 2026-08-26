import { renderHook, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useWalletEnhanced } from './use-wallet-enhanced'
import { useWalletStore } from '@/store/wallet-store'
import { walletService } from '@/lib/wallet/wallet-service'
import { getSorobanSDK, __clearSorobanSDKCache } from '@/lib/soroban/sdk'

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

jest.mock('@stellar/wallet-sdk', () => ({
  WalletKit: jest.fn().mockImplementation(() => ({
    getAddress: jest.fn(),
  })),
}))

jest.mock('@stellar/freighter-api', () => ({
  isConnected: jest.fn(),
  getAddress: jest.fn(),
  signTransaction: jest.fn(),
  getNetwork: jest.fn(),
}))

jest.mock('@/lib/wallet/wallet-service', () => {
  const actual = jest.requireActual('@/lib/wallet/wallet-service')
  return {
    ...actual,
    walletService: {
      getNetwork: jest.fn(),
      connectFreighter: jest.fn(),
      disconnect: jest.fn(),
    },
  }
})

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

describe('useWalletEnhanced.switchNetwork (issue #105)', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    __clearSorobanSDKCache()
    useWalletStore.setState({
      isConnected: true,
      address: 'GABC123',
      publicKey: 'GABC123',
      network: 'testnet',
      balance: '0',
    })
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    ;(walletService.getNetwork as jest.Mock).mockReset()
  })

  it('updates the store and clears the query cache on a successful switch', async () => {
    ;(walletService.getNetwork as jest.Mock).mockResolvedValue('PUBLIC')
    queryClient.setQueryData(['network', 'testnet', 'balance'], '100')
    expect(queryClient.getQueryCache().findAll().length).toBeGreaterThan(0)

    const { result } = renderHook(() => useWalletEnhanced(), { wrapper: wrapper(queryClient) })

    await act(async () => {
      await result.current.switchNetwork('mainnet')
    })

    expect(useWalletStore.getState().network).toBe('mainnet')
    expect(queryClient.getQueryCache().findAll().length).toBe(0)
  })

  it('aborts and does NOT update the store when Freighter reports a mismatched network', async () => {
    ;(walletService.getNetwork as jest.Mock).mockResolvedValue('TESTNET')

    const { result } = renderHook(() => useWalletEnhanced(), { wrapper: wrapper(queryClient) })

    await act(async () => {
      await result.current.switchNetwork('mainnet')
    })

    expect(useWalletStore.getState().network).toBe('testnet')
  })

  it('recreates the SDK instance for the new network on switch', async () => {
    ;(walletService.getNetwork as jest.Mock).mockResolvedValue('PUBLIC')
    const testnetSdkBefore = getSorobanSDK('testnet')

    const { result } = renderHook(() => useWalletEnhanced(), { wrapper: wrapper(queryClient) })

    await act(async () => {
      await result.current.switchNetwork('mainnet')
    })

    const mainnetSdk = getSorobanSDK('mainnet')
    expect(mainnetSdk.networkPassphrase).toBe('Public Global Stellar Network ; September 2015')

    const testnetSdkAfter = getSorobanSDK('testnet')
    expect(testnetSdkAfter).not.toBe(testnetSdkBefore)
  })

  it('skips the Freighter check for standalone network', async () => {
    const { result } = renderHook(() => useWalletEnhanced(), { wrapper: wrapper(queryClient) })

    await act(async () => {
      await result.current.switchNetwork('standalone')
    })

    expect(walletService.getNetwork).not.toHaveBeenCalled()
    expect(useWalletStore.getState().network).toBe('standalone')
  })
})

// ---------------------------------------------------------------------------
// AC5 — Integration test: connectWallet stores real balance (issue #86)
// ---------------------------------------------------------------------------

describe('useWalletEnhanced.connectWallet stores real Horizon balance (AC5)', () => {
  let queryClient: QueryClient
  const MOCK_ADDRESS = 'GABC456TESTADDRESS'
  const MOCK_BALANCE = '9999.9999800'

  beforeEach(() => {
    __clearSorobanSDKCache()
    // Start with a disconnected wallet on testnet.
    useWalletStore.setState({
      isConnected: false,
      address: null,
      publicKey: null,
      network: 'testnet',
      balance: '0',
    })
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    jest.clearAllMocks()
  })

  it('stores the mocked Horizon balance in the wallet store after connectWallet()', async () => {
    // Mock Freighter to return our test address.
    ;(walletService.connectFreighter as jest.Mock).mockResolvedValue({
      address: MOCK_ADDRESS,
      publicKey: MOCK_ADDRESS,
    })

    // Spy on getBalance of the SDK instance that will be used by connectWallet.
    // connectWallet calls getSorobanSDK(store.network).getBalance(), so we
    // pre-warm the cache and then spy on the resulting instance.
    const sdk = getSorobanSDK('testnet')
    jest.spyOn(sdk, 'getBalance').mockResolvedValue(MOCK_BALANCE)

    const { result } = renderHook(() => useWalletEnhanced(), { wrapper: wrapper(queryClient) })

    await act(async () => {
      await result.current.connectWallet()
    })

    // The wallet store should have the real (mocked) balance, not '0'.
    expect(useWalletStore.getState().balance).toBe(MOCK_BALANCE)
    expect(useWalletStore.getState().balance).not.toBe('0')
    expect(useWalletStore.getState().isConnected).toBe(true)
    expect(useWalletStore.getState().address).toBe(MOCK_ADDRESS)
  })

  it('calls getBalance with the connected wallet address', async () => {
    ;(walletService.connectFreighter as jest.Mock).mockResolvedValue({
      address: MOCK_ADDRESS,
      publicKey: MOCK_ADDRESS,
    })

    const sdk = getSorobanSDK('testnet')
    const getBalanceSpy = jest.spyOn(sdk, 'getBalance').mockResolvedValue('42.0000000')

    const { result } = renderHook(() => useWalletEnhanced(), { wrapper: wrapper(queryClient) })

    await act(async () => {
      await result.current.connectWallet()
    })

    expect(getBalanceSpy).toHaveBeenCalledWith(MOCK_ADDRESS)
  })
})
