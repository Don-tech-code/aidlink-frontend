import { useCallback, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useWalletStore } from '@/store/wallet-store';
import { getSorobanSDK, invalidateSorobanSDK, type NetworkName } from '@/lib/soroban/sdk';
import { walletService, FREIGHTER_NETWORK_MAP } from '@/lib/wallet/wallet-service';

export interface WalletInfo {
  publicKey: string;
  balance: number;
  network: NetworkName;
  isConnected: boolean;
}

/**
 * Previously this hook held its own local `useState` wallet object,
 * completely disconnected from `useWalletStore` — `wallet-manager.tsx` read
 * from here while `useConnectWallet`/`useSwitchNetwork` in use-wallet.ts
 * wrote to the Zustand store, so the two never agreed on the wallet's
 * actual state. `switchNetwork()` only ever updated this hook's local
 * state, never `walletStore.network`, so the SDK/signing layer (which both
 * read from the store) stayed frozen on whatever network they started on.
 *
 * This version reads and writes through `useWalletStore` as the single
 * source of truth, and drives the SorobanSDK factory, Freighter, and React
 * Query cache invalidation directly from it.
 */
export function useWalletEnhanced() {
  const store = useWalletStore();
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wallet: WalletInfo = useMemo(
    () => ({
      publicKey: store.publicKey ?? '',
      balance: Number.parseFloat(store.balance) || 0,
      network: store.network,
      isConnected: store.isConnected,
    }),
    [store.publicKey, store.balance, store.network, store.isConnected]
  );

  const connectWallet = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const info = await walletService.connectFreighter();
      const sdk = getSorobanSDK(store.network);
      const balance = await sdk.getBalance(info.address);

      store.setWallet({
        isConnected: true,
        address: info.address,
        publicKey: info.publicKey,
        balance,
      });
    } catch (err) {
      setError('Failed to connect wallet');
      console.error(err);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.network]);

  const disconnectWallet = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await walletService.disconnect();
      store.disconnect();
    } catch (err) {
      setError('Failed to disconnect wallet');
      console.error(err);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Atomic network switch (issue #105):
   *   1. Verify Freighter is actually on the requested network (skipped for
   *      'standalone', which Freighter has no concept of).
   *   2. Update the wallet store.
   *   3. Invalidate the previous network's cached SDK instance.
   *   4. Refresh the balance against the new network's SDK/RPC.
   *   5. Clear all React Query caches so stale cross-network data (balances,
   *      campaigns, analytics) is never served, even briefly.
   */
  const switchNetwork = useCallback(
    async (network: NetworkName) => {
      setLoading(true);
      setError(null);

      const previousNetwork = store.network;

      try {
        if (network !== 'standalone') {
          const freighterNetwork = await walletService.getNetwork();
          const expected = FREIGHTER_NETWORK_MAP[network];
          if (freighterNetwork !== expected) {
            toast.error(`Please switch to ${network} in your Freighter extension first`);
            setLoading(false);
            return;
          }
        }

        store.switchNetwork(network);
        invalidateSorobanSDK(previousNetwork);
        const sdk = getSorobanSDK(network);

        // Balance refresh is best-effort here: a transient RPC error while
        // fetching the new network's balance shouldn't roll back a switch
        // that already succeeded (store updated, Freighter confirmed) or
        // skip clearing stale cross-network cache data below.
        if (store.address) {
          try {
            const balance = await sdk.getBalance(store.address);
            store.setWallet({ balance });
          } catch (balanceErr) {
            console.error('Error refreshing balance after network switch:', balanceErr);
          }
        }

        // Stale testnet contract state must never appear in the mainnet UI
        // even briefly — clear() drops cached data outright rather than
        // merely marking it stale.
        queryClient.clear();
        await queryClient.invalidateQueries();

        toast.success(`Switched to ${network}`);
      } catch (err) {
        setError('Failed to switch network');
        console.error(err);
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store.network, store.address, queryClient]
  );

  const refreshBalance = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (!store.address) {
        return;
      }
      const sdk = getSorobanSDK(store.network);
      const balance = await sdk.getBalance(store.address);
      store.setWallet({ balance });
    } catch (err) {
      setError('Failed to refresh balance');
      console.error(err);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.network, store.address]);

  return {
    wallet,
    loading,
    error,
    connectWallet,
    disconnectWallet,
    switchNetwork,
    refreshBalance,
  };
}
