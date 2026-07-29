'use client';

import React from 'react';
import { withRequireRole } from '@/components/providers/auth-provider';

function CreateCampaignPage() {
  return (
    <div className="container mx-auto p-6">
      <h1 className="text-2xl font-bold">Create New Campaign</h1>
      <p className="text-muted-foreground mt-2">Only verified NGOs and admins can launch campaigns.</p>
    </div>
  );
}

export default withRequireRole(CreateCampaignPage, ['ngo', 'admin']);
