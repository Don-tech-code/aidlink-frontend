'use client';

import { useLocale } from 'next-intl';
import { useAnalytics } from '@/hooks/use-analytics';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatAmount } from '@/lib/utils';

export function CampaignAnalytics({ campaignId }: { campaignId: string }) {
  const locale = useLocale();
  const { analytics, loading, error } = useAnalytics(campaignId);

  if (loading) return <p>Loading analytics...</p>;
  if (error) return <p className="text-red-500">{error}</p>;
  if (!analytics) return null;

  return (
    <div className="space-y-6">
      <Card className="p-6">
        <h3 className="text-lg font-semibold mb-4">Campaign Overview</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <p className="text-sm text-muted-foreground">Total Donations</p>
            <p className="text-2xl font-bold">{analytics.totalDonations}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Total Amount</p>
            <p className="text-2xl font-bold">{formatAmount(analytics.totalAmount, 2, locale)} XLM</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Unique Donors</p>
            <p className="text-2xl font-bold">{analytics.uniqueDonors}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Average Donation</p>
            <p className="text-2xl font-bold">{analytics.averageDonation.toFixed(2)} XLM</p>
          </div>
        </div>
      </Card>

      <Card className="p-6">
        <h3 className="text-lg font-semibold mb-4">Daily Donations</h3>
        <div className="space-y-2">
          {analytics.dailyDonations.map((day) => (
            <div key={day.date} className="flex justify-between items-center">
              <span className="text-sm">{day.date}</span>
              <Badge variant="secondary">{formatAmount(day.amount, 2, locale)} XLM</Badge>
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-6">
        <h3 className="text-lg font-semibold mb-4">Donor Distribution</h3>
        <div className="space-y-2">
          {analytics.donorDistribution.map((dist) => (
            <div key={dist.range} className="flex justify-between items-center">
              <span className="text-sm">{dist.range} XLM</span>
              <Badge variant="outline">{dist.count} donors</Badge>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
