'use client';

import React, { useState } from 'react';
import { withRequireRole } from '@/components/providers/auth-provider';
import { beneficiaryRegistryClient } from '@/lib/soroban/beneficiary-registry';
import { toast } from 'sonner';

function AdminPage() {
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const handleVerify = async (beneficiaryId: string) => {
    setLoadingId(beneficiaryId);
    try {
      await beneficiaryRegistryClient.updateVerificationStatus(beneficiaryId, 1);
      toast.success(`Beneficiary ${beneficiaryId} verified on-chain.`);
    } catch (err) {
      toast.error('Failed to verify beneficiary on contract');
    } finally {
      setLoadingId(null);
    }
  };

  const handleSuspend = async (beneficiaryId: string) => {
    setLoadingId(beneficiaryId);
    try {
      await beneficiaryRegistryClient.updateVerificationStatus(beneficiaryId, 2);
      toast.warning(`Beneficiary ${beneficiaryId} suspended.`);
    } catch (err) {
      toast.error('Failed to suspend beneficiary on contract');
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <h1 className="text-3xl font-bold">Admin Dashboard</h1>
      <p className="text-muted-foreground">Manage beneficiary verifications and platform security.</p>
      
      <div className="border rounded-lg p-4 bg-card space-y-4">
        <h2 className="text-xl font-semibold">Beneficiary Actions</h2>
        <div className="flex items-center justify-between p-3 border rounded">
          <span>Beneficiary ID: G_EXAMPLE_BENEFICIARY</span>
          <div className="space-x-2">
            <button
              onClick={() => handleVerify('G_EXAMPLE_BENEFICIARY')}
              disabled={loadingId === 'G_EXAMPLE_BENEFICIARY'}
              className="px-3 py-1 bg-green-600 text-white rounded text-sm disabled:opacity-50"
            >
              Verify
            </button>
            <button
              onClick={() => handleSuspend('G_EXAMPLE_BENEFICIARY')}
              disabled={loadingId === 'G_EXAMPLE_BENEFICIARY'}
              className="px-3 py-1 bg-red-600 text-white rounded text-sm disabled:opacity-50"
            >
              Suspend
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default withRequireRole(AdminPage, ['admin']);
