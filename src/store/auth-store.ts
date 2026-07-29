import { create } from 'zustand';
import { User, UserRole } from '@/types';
import { beneficiaryRegistryClient } from '@/lib/soroban/beneficiary-registry';

interface AuthState {
  user: User | null;
  roleLoadingState: 'idle' | 'loading' | 'loaded' | 'error';
  lastFetch: number | null;
  fetchRole: (publicKey: string) => Promise<void>;
  clearRole: () => void;
}

const TTL_MS = 30000; // 30 seconds

function setRoleCookie(role: UserRole | null) {
  if (typeof document === 'undefined') return;
  if (role) {
    document.cookie = `auth-role=${role}; path=/; max-age=3600; SameSite=Lax`;
  } else {
    document.cookie = 'auth-role=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax';
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  roleLoadingState: 'idle',
  lastFetch: null,

  fetchRole: async (publicKey: string) => {
    if (!publicKey) {
      get().clearRole();
      return;
    }

    const now = Date.now();
    const { lastFetch, roleLoadingState } = get();

    if (lastFetch && now - lastFetch < TTL_MS && roleLoadingState === 'loaded') {
      return;
    }

    set({ roleLoadingState: 'loading' });

    try {
      const role = await beneficiaryRegistryClient.getRole(publicKey);

      const user: User = {
        id: publicKey,
        walletAddress: publicKey,
        role: role || 'donor',
      };

      setRoleCookie(user.role);
      set({
        user,
        roleLoadingState: 'loaded',
        lastFetch: Date.now(),
      });
    } catch (error) {
      console.error('Failed to fetch user role:', error);
      set({ roleLoadingState: 'error' });
    }
  },

  clearRole: () => {
    setRoleCookie(null);
    set({
      user: null,
      roleLoadingState: 'idle',
      lastFetch: null,
    });
  },
}));
