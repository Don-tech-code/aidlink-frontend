import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { PersistStorage } from 'zustand/middleware'
import type { WalletState } from '@/types'
import { getSorobanSDK } from '@/lib/soroban/sdk'

/**
 * Session TTL: 8 hours. Matches the value asserted in
 * src/lib/store/__tests__/encrypted-storage.test.ts's TTL-expiry test.
 */
const SESSION_TTL_MS = 8 * 60 * 60 * 1000

interface WalletStore extends WalletState {
  connectedAt: number | null
  sessionTtlMs: number
  setWallet: (wallet: Partial<WalletState>) => void
  disconnect: () => void
  switchNetwork: (network: 'mainnet' | 'testnet' | 'futurenet' | 'standalone') => void
}

type WalletPersistedState = Pick<
  WalletStore,
  'isConnected' | 'address' | 'network' | 'connectedAt'
>

export const useWalletStore = create<WalletStore>()(
  persist(
    (set) => ({
      isConnected: false,
      address: null,
      publicKey: null,
      network: 'testnet',
      balance: '0',
      connectedAt: null,
      sessionTtlMs: SESSION_TTL_MS,
      setWallet: (wallet) =>
        set((state) => ({
          ...state,
          ...wallet,
          ...(wallet.isConnected ? { connectedAt: Date.now() } : {}),
        })),
      disconnect: () =>
        set({
          isConnected: false,
          address: null,
          publicKey: null,
          balance: '0',
          connectedAt: null,
        }),
      switchNetwork: (network) => set({ network }),
    }),
    {
      name: 'wallet-storage',
      // Previously, if a user last used mainnet, the store would rehydrate
      // with network: 'mainnet' while the old sorobanSDK singleton stayed
      // permanently bound to 'testnet' from module import — desyncing the
      // store and the SDK on every reload after a switch. Pre-warming the
      // SDK cache for the persisted network here closes that gap.
      onRehydrateStorage: () => (state) => {
        if (state) {
          getSorobanSDK(state.network)
        }
      },
    }
  )
)
