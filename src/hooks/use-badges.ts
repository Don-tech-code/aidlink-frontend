'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useWalletStore } from '@/store/wallet-store';
import { BADGE_DEFINITIONS, BadgeState } from '@/lib/gamification/badge-rules';
import { indexTransactions, TransactionEvent } from '@/lib/gamification/transaction-indexer';
import { evaluateBadge } from '@/lib/gamification/badge-evaluator';
import { loadBadgeState, saveBadgeState } from '@/lib/gamification/badge-storage';
import { toast } from 'sonner';
import confetti from 'canvas-confetti';

export function useBadges() {
  const { publicKey, network } = useWalletStore();
  const [badgeStates, setBadgeStates] = useState<Record<string, BadgeState>>({});
  const [loading, setLoading] = useState<boolean>(true);
  const eventsRef = useRef<TransactionEvent[]>([]);

  const syncAndEvaluate = useCallback(async () => {
    if (!publicKey) {
      setBadgeStates({});
      setLoading(false);
      return;
    }

    setLoading(true);

    try {
      const { states: cachedStates, cursor } = await loadBadgeState(publicKey);
      const cachedMap: Record<string, BadgeState> = {};
      cachedStates.forEach((s) => {
        cachedMap[s.badgeId] = s;
      });

      const { events, cursor: newCursor } = await indexTransactions(publicKey, undefined, {
        cursor: cursor || undefined,
      });

      eventsRef.current = [...eventsRef.current, ...events];

      const updatedStates: BadgeState[] = [];
      const newMap: Record<string, BadgeState> = {};

      for (const def of BADGE_DEFINITIONS) {
        const evalResult = evaluateBadge(def.rule, eventsRef.current);
        const previousState = cachedMap[def.id];

        const isNewlyUnlocked = evalResult.unlocked && (!previousState || !previousState.unlocked);

        const state: BadgeState = {
          badgeId: def.id,
          progress: evalResult.progress,
          maxProgress: evalResult.maxProgress,
          unlocked: evalResult.unlocked,
          unlockedAt: isNewlyUnlocked ? new Date().toISOString() : previousState?.unlockedAt,
        };

        newMap[def.id] = state;
        updatedStates.push(state);

        if (isNewlyUnlocked) {
          toast.success(`🎉 Badge Unlocked: ${def.name}!`, {
            description: def.description,
          });
          confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
        }
      }

      setBadgeStates(newMap);
      await saveBadgeState(publicKey, updatedStates, newCursor);
    } catch (err) {
      console.error('Failed to sync gamification badges:', err);
    } finally {
      setLoading(false);
    }
  }, [publicKey, network]);

  useEffect(() => {
    eventsRef.current = [];
    syncAndEvaluate();
  }, [publicKey, network, syncAndEvaluate]);

  return {
    badges: BADGE_DEFINITIONS.map((def) => ({
      ...def,
      state: badgeStates[def.id] || {
        badgeId: def.id,
        progress: 0,
        maxProgress: 1,
        unlocked: false,
      },
    })),
    loading,
    refreshBadges: syncAndEvaluate,
  };
}
