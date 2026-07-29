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
