import { BadgeRule } from './badge-rules';
import { TransactionEvent } from './transaction-indexer';

export function evaluateBadge(
  rule: BadgeRule,
  events: TransactionEvent[]
): { progress: number; maxProgress: number; unlocked: boolean } {
  const donations = events.filter((e) => e.type === 'donation');

  switch (rule.type) {
    case 'first_donation': {
      const unlocked = donations.length > 0;
      return { progress: unlocked ? 1 : 0, maxProgress: 1, unlocked };
    }

    case 'total_donations': {
      const progress = donations.length;
      return {
        progress,
        maxProgress: rule.threshold,
        unlocked: progress >= rule.threshold,
      };
    }

    case 'total_donated_amount': {
      const sum = donations
        .filter((e) => e.currency === rule.currency)
        .reduce((acc, curr) => acc + curr.amount, 0);
      return {
        progress: Math.floor(sum),
        maxProgress: rule.threshold,
        unlocked: sum >= rule.threshold,
      };
    }

    case 'unique_campaigns_supported': {
      const uniqueRecipients = new Set(
        donations.map((e) => e.recipient).filter(Boolean)
      );
      const progress = uniqueRecipients.size;
      return {
        progress,
        maxProgress: rule.threshold,
        unlocked: progress >= rule.threshold,
      };
    }

    case 'donation_streak_days': {
      if (donations.length === 0) {
        return { progress: 0, maxProgress: rule.days, unlocked: false };
      }

      const dayBuckets = Array.from(
        new Set(
          donations.map((e) =>
            Math.floor(e.timestamp.getTime() / 86400000)
          )
        )
      ).sort((a, b) => a - b);

      let maxStreak = 1;
      let currentStreak = 1;

      for (let i = 1; i < dayBuckets.length; i++) {
        if (dayBuckets[i] === dayBuckets[i - 1] + 1) {
          currentStreak++;
          if (currentStreak > maxStreak) maxStreak = currentStreak;
        } else {
          currentStreak = 1;
        }
      }

      return {
        progress: maxStreak,
        maxProgress: rule.days,
        unlocked: maxStreak >= rule.days,
      };
    }

    default:
      return { progress: 0, maxProgress: 1, unlocked: false };
  }
}
