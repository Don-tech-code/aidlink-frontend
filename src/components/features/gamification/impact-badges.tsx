'use client';

import React from 'react';
import { useBadges } from '@/hooks/use-badges';

export function ImpactBadges() {
  const { badges, loading } = useBadges();

  if (loading) {
    return (
      <div className="p-6 text-center text-muted-foreground animate-pulse">
        Evaluating impact badges and on-chain history...
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-4">
      {badges.map((badge) => {
        const { state } = badge;
        const percent = Math.min(
          100,
          Math.round((state.progress / state.maxProgress) * 100)
        );

        return (
          <div
            key={badge.id}
            className={`border rounded-xl p-4 flex flex-col justify-between transition-all ${
              state.unlocked
                ? 'bg-card border-primary/50 shadow-sm'
                : 'bg-muted/30 border-border/40 opacity-70'
            }`}
          >
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-3xl">{badge.icon}</span>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full font-medium uppercase ${
                    badge.rarity === 'legendary'
                      ? 'bg-amber-500/20 text-amber-500'
                      : badge.rarity === 'epic'
                      ? 'bg-purple-500/20 text-purple-500'
                      : badge.rarity === 'rare'
                      ? 'bg-blue-500/20 text-blue-500'
                      : 'bg-slate-500/20 text-slate-500'
                  }`}
                >
                  {badge.rarity}
                </span>
              </div>
              <h3 className="font-semibold text-lg">{badge.name}</h3>
              <p className="text-sm text-muted-foreground mt-1">
                {badge.description}
              </p>
            </div>

            <div className="mt-4 pt-3 border-t">
              <div className="flex justify-between text-xs font-medium mb-1">
                <span>{state.unlocked ? 'Unlocked' : 'Progress'}</span>
                <span>
                  {state.progress} / {state.maxProgress}
                </span>
              </div>
              <div className="w-full bg-secondary h-2 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all duration-500 ${
                    state.unlocked ? 'bg-primary' : 'bg-primary/50'
                  }`}
                  style={{ width: `${percent}%` }}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
