import React from 'react';

export type BadgeRule =
  | { type: 'first_donation' }
  | { type: 'total_donations'; threshold: number }
  | { type: 'total_donated_amount'; threshold: number; currency: 'XLM' | 'AID' }
  | { type: 'donation_streak_days'; days: number }
  | { type: 'unique_campaigns_supported'; threshold: number };

export interface BadgeDefinition {
  id: string;
  name: string;
  description: string;
  rule: BadgeRule;
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
  icon: string;
}

export interface BadgeState {
  badgeId: string;
  progress: number;
  maxProgress: number;
  unlocked: boolean;
  unlockedAt?: string;
}

export const BADGE_DEFINITIONS: BadgeDefinition[] = [
  {
    id: 'first_donation',
    name: 'First Steps',
    description: 'Make your very first donation on AidLink.',
    rule: { type: 'first_donation' },
    rarity: 'common',
    icon: '🌱',
  },
  {
    id: 'generous_giver',
    name: 'Generous Giver',
    description: 'Complete 5 donations to support causes.',
    rule: { type: 'total_donations', threshold: 5 },
    rarity: 'rare',
    icon: '💖',
  },
  {
    id: 'century_club',
    name: 'Century Club',
    description: 'Donate a cumulative total of 100 XLM.',
    rule: { type: 'total_donated_amount', threshold: 100, currency: 'XLM' },
    rarity: 'epic',
    icon: '💯',
  },
  {
    id: 'donation_streak',
    name: 'Daily Supporter',
    description: 'Maintain a 3-day consecutive donation streak.',
    rule: { type: 'donation_streak_days', days: 3 },
    rarity: 'rare',
    icon: '🔥',
  },
  {
    id: 'campaign_explorer',
    name: 'Campaign Explorer',
    description: 'Donate to 3 unique campaigns or beneficiaries.',
    rule: { type: 'unique_campaigns_supported', threshold: 3 },
    rarity: 'epic',
    icon: '🧭',
  },
  {
    id: 'legendary_patron',
    name: 'Legendary Patron',
    description: 'Donate a cumulative total of 1,000 XLM.',
    rule: { type: 'total_donated_amount', threshold: 1000, currency: 'XLM' },
    rarity: 'legendary',
    icon: '👑',
  },
];
