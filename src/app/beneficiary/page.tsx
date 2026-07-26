'use client';

import React from 'react';
import { withRequireRole } from '@/components/providers/auth-provider';

function BeneficiaryPortalPage() {
  return (
    <div className="container mx-auto p-6">
      <h1 className="text-2xl font-bold">Beneficiary Portal</h1>
      <p className="text-muted-foreground mt-2 font-medium">Manage your aid disbursements and requests.</p>
    </div>
  );
}

export default withRequireRole(BeneficiaryPortalPage, ['beneficiary', 'admin']);
