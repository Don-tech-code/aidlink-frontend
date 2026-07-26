import { openDB, DBSchema } from 'idb';
import { BadgeState } from './badge-rules';

interface AidLinkGamificationDB extends DBSchema {
  badges: {
    key: string;
    value: {
      key: string;
      publicKey: string;
      badgeId: string;
      progress: number;
      maxProgress: number;
      unlocked: boolean;
      unlockedAt?: string;
      lastSyncedCursor: string;
    };
    indexes: { 'by-public-key': string };
  };
}

const DB_NAME = 'aidlink-gamification-db';
const DB_VERSION = 1;

async function getDB() {
  return openDB<AidLinkGamificationDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('badges')) {
        const store = db.createObjectStore('badges', { keyPath: 'key' });
        store.createIndex('by-public-key', 'publicKey');
      }
    },
  });
}

export async function saveBadgeState(
  publicKey: string,
  badgeStates: BadgeState[],
  cursor: string
): Promise<void> {
  if (!publicKey) return;
  const db = await getDB();
  const tx = db.transaction('badges', 'readwrite');

  for (const state of badgeStates) {
    const key = `${publicKey}:${state.badgeId}`;
    await tx.store.put({
      key,
      publicKey,
      badgeId: state.badgeId,
      progress: state.progress,
      maxProgress: state.maxProgress,
      unlocked: state.unlocked,
      unlockedAt: state.unlockedAt,
      lastSyncedCursor: cursor,
    });
  }

  await tx.done;
}

export async function loadBadgeState(
  publicKey: string
): Promise<{ states: BadgeState[]; cursor: string | null }> {
  if (!publicKey) return { states: [], cursor: null };
  const db = await getDB();
  const records = await db.getAllFromIndex('badges', 'by-public-key', publicKey);

  if (!records || records.length === 0) {
    return { states: [], cursor: null };
  }

  const cursor = records[0].lastSyncedCursor || null;
  const states: BadgeState[] = records.map((r) => ({
    badgeId: r.badgeId,
    progress: r.progress,
    maxProgress: r.maxProgress,
    unlocked: r.unlocked,
    unlockedAt: r.unlockedAt,
  }));

  return { states, cursor };
}
