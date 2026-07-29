'use client';

import { useState } from 'react';
import { useLocale } from 'next-intl';
import { useDonations } from '@/hooks/use-donations';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDate } from '@/lib/utils';

export function DonationTracker({ campaignId }: { campaignId: string }) {
  const locale = useLocale();
  const { donations, loading, error, trackDonation, refresh } = useDonations(campaignId);
  const [amount, setAmount] = useState('');

  const handleDonate = async () => {
    if (!amount) return;
    const result = await trackDonation(parseFloat(amount));
    if (result.success) {
      setAmount('');
      refresh();
    }
  };

  return (
    <div className="space-y-6">
      <Card className="p-6">
        <h3 className="text-lg font-semibold mb-4">Make a Donation</h3>
        <div className="flex gap-4">
          <Input
            type="number"
            placeholder="Amount (XLM)"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="max-w-xs"
          />
          <Button onClick={handleDonate} disabled={loading}>
            {loading ? 'Processing...' : 'Donate'}
          </Button>
        </div>
        {error && <p className="text-red-500 mt-2">{error}</p>}
      </Card>

      <Card className="p-6">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold">Recent Donations</h3>
          <Badge variant="secondary">{donations.length} total</Badge>
        </div>
        
        {loading ? (
          <p>Loading donations...</p>
        ) : donations.length === 0 ? (
          <p className="text-muted-foreground">No donations yet</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Donor</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Transaction</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {donations.map((donation) => (
                <TableRow key={donation.id}>
                  <TableCell className="font-mono">{donation.donor.slice(0, 8)}...</TableCell>
                  <TableCell>{donation.amount} XLM</TableCell>
                  <TableCell>{formatDate(donation.timestamp, locale)}</TableCell>
                  <TableCell className="font-mono">{donation.transactionHash.slice(0, 10)}...</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
