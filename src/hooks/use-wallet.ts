import { useMutation } from '@tanstack/react-query'
import { useWalletStore } from '@/store/wallet-store'
import { toast } from 'sonner'
import type { WalletId } from '@/lib/wallet/wallet-service'

export function useConnectWallet() {
  const { setWallet, network } = useWalletStore()

  return useMutation({
    mutationFn: async (walletId: WalletId) => {
      const { walletService } = await import('@/lib/wallet/wallet-service')
      
      // Connect with the specified wallet and current network
      const walletInfo = await walletService.connect(walletId, network)
      
      // Get balance from Soroban SDK
      const { sorobanSDK } = await import('@/lib/soroban/sdk')
      const balance = await sorobanSDK.getBalance(walletInfo.address)
      
      return {
        address: walletInfo.address,
        publicKey: walletInfo.publicKey,
        network: walletInfo.network as 'mainnet' | 'testnet' | 'futurenet' | 'standalone',
        balance,
      }
    },
    onSuccess: (wallet) => {
      setWallet({
        isConnected: true,
        ...wallet,
      })
      toast.success('Wallet connected successfully')
    },
    onError: (error) => {
      toast.error('Failed to connect wallet', {
        description: error instanceof Error ? error.message : 'Unknown error',
      })
    },
  })
}

export function useDisconnectWallet() {
  const disconnect = useWalletStore((state) => state.disconnect)

  return useMutation({
    mutationFn: async () => {
      const { walletService } = await import('@/lib/wallet/wallet-service')
      await walletService.disconnect()
      return true
    },
    onSuccess: () => {
      disconnect()
      toast.success('Wallet disconnected')
    },
  })
}

/**
 * @deprecated This mutation only updates `walletStore.network` after a fake
 * delay — it does not verify Freighter's actual network, does not recreate
 * the SorobanSDK for the new network, and does not invalidate React Query
 * caches. Switching networks this way leaves the SDK/signing layer frozen
 * on the previous network (issue #105). Use `useWalletEnhanced().switchNetwork`
 * instead, which performs the full atomic switch.
 */
export function useSwitchNetwork() {
  const switchNetwork = useWalletStore((state) => state.switchNetwork)

  return useMutation({
    mutationFn: async (network: 'mainnet' | 'testnet' | 'futurenet' | 'standalone') => {
      await new Promise((resolve) => setTimeout(resolve, 500))
      return network
    },
    onSuccess: (network) => {
      switchNetwork(network)
      toast.success(`Switched to ${network}`)
    },
  })
}
