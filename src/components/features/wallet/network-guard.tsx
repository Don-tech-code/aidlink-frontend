'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useWalletStore } from '@/store/wallet-store';
import { walletService, FREIGHTER_NETWORK_MAP, type FreighterNetwork } from '@/lib/wallet/wallet-service';

const POLL_INTERVAL_MS = 5000;

/**
 * Non-blocking guard (issue #105) that warns when the connected Freighter
 * wallet's network diverges from `walletStore.network`, and disables any
 * button opted into `data-requires-wallet` while the mismatch persists.
 *
 * This never gates page rendering — `children` always render regardless of
 * mismatch state, per the issue's explicit "non-blocking warning, not a
 * hard gate" constraint.
 */
export function NetworkGuard({ children }: { children: ReactNode }) {
  const storeNetwork = useWalletStore((s) => s.network);
  const isConnected = useWalletStore((s) => s.isConnected);
  const [freighterNetwork, setFreighterNetwork] = useState<FreighterNetwork | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      // Standalone requires manual RPC configuration and has no Freighter
      // equivalent — skip the comparison entirely rather than reporting a
      // false mismatch.
      if (!isConnected || storeNetwork === 'standalone') {
        if (!cancelled) {
          setFreighterNetwork(null);
          setChecked(true);
        }
        return;
      }
      try {
        const current = await walletService.getNetwork();
        if (!cancelled) {
          setFreighterNetwork(current);
          setChecked(true);
        }
      } catch {
        if (!cancelled) setChecked(true);
      }
    }

    check();
    const interval = setInterval(check, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [storeNetwork, isConnected]);

  const expected: FreighterNetwork | null =
    storeNetwork === 'standalone' ? null : FREIGHTER_NETWORK_MAP[storeNetwork];
  const mismatch =
    isConnected &&
    storeNetwork !== 'standalone' &&
    checked &&
    freighterNetwork !== null &&
    freighterNetwork !== expected;

  // Best-effort DOM sweep so any <Button data-requires-wallet> is disabled
  // while a mismatch is present, even for buttons rendered by components
  // that don't read `mismatch` directly.
  useEffect(() => {
    const buttons = document.querySelectorAll<HTMLButtonElement>('button[data-requires-wallet]');
    buttons.forEach((btn) => {
      btn.disabled = mismatch;
    });
  }, [mismatch]);

  return (
    <>
      {mismatch && (
        <div
          role="alert"
          data-testid="network-mismatch-banner"
          className="sticky top-0 z-50 flex items-center justify-center gap-2 bg-destructive px-4 py-2 text-center text-sm font-medium text-destructive-foreground"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            Your Freighter wallet is on {freighterNetwork} but AidLink is configured for{' '}
            {storeNetwork}. Switch networks to continue.
          </span>
        </div>
      )}
      {isConnected && storeNetwork === 'standalone' && (
        <div
          role="status"
          data-testid="standalone-notice"
          className="sticky top-0 z-50 flex items-center justify-center gap-2 bg-muted px-4 py-2 text-center text-sm text-muted-foreground"
        >
          Standalone network requires manual RPC configuration.
        </div>
      )}
      {children}
    </>
  );
}
