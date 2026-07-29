import { getSorobanSDK, __clearSorobanSDKCache } from '@/lib/soroban/sdk'

describe('wallet store rehydration pre-warms the SDK cache (issue #105)', () => {
  beforeEach(() => {
    __clearSorobanSDKCache()
    jest.resetModules()
    window.localStorage.clear()
  })

  it('calls getSorobanSDK(state.network) via onRehydrateStorage for a persisted mainnet session', async () => {
    const persisted = JSON.stringify({
      state: {
        isConnected: true,
        address: 'GABC123',
        publicKey: 'GABC123',
        network: 'mainnet',
        balance: '42',
      },
      version: 0,
    })
    window.localStorage.setItem('wallet-storage', persisted)

    const { useWalletStore } = await import('./wallet-store')

    // Let the persist middleware's async rehydration microtask flush.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useWalletStore.getState().network).toBe('mainnet')

    const mainnetSdk = getSorobanSDK('mainnet')
    expect(mainnetSdk.networkPassphrase).toBe('Public Global Stellar Network ; September 2015')
  })
})
