'use client';

import React, { createContext, useContext, useEffect } from 'react';
import { useAuthStore } from '@/store/auth-store';
import { useWalletStore } from '@/store/wallet-store';
import { UserRole } from '@/types';

export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized access') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

interface AuthContextType {
  role: UserRole | null;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType>({ role: null, loading: true });

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { publicKey } = useWalletStore();
  const { user, roleLoadingState, fetchRole, clearRole } = useAuthStore();

  useEffect(() => {
    if (publicKey) {
      fetchRole(publicKey);
    } else {
      clearRole();
    }
  }, [publicKey, fetchRole, clearRole]);

  const value = {
    role: user?.role || null,
    loading: roleLoadingState === 'loading',
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useRole() {
  const context = useContext(AuthContext);
  const user = useAuthStore((s) => s.user);
  return { role: user?.role || null, loading: context.loading };
}

export function useRequireRole(allowedRoles: UserRole[]) {
  const { role, loading } = useRole();

  if (!loading && (!role || !allowedRoles.includes(role))) {
    throw new UnauthorizedError(`Access restricted to roles: ${allowedRoles.join(', ')}`);
  }

  return { role, loading };
}

export function withRequireRole<P extends object>(
  Component: React.ComponentType<P>,
  allowedRoles: UserRole[]
) {
  return function ProtectedComponent(props: P) {
    useRequireRole(allowedRoles);
    return <Component {...props} />;
  };
}
