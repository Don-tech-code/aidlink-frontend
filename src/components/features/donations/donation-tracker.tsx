'use client'

import { useState } from 'react'
import { useDonations } from '@/hooks/use-donations'
import { FeeConfirmationDialog } from '@/components/features/donations/fee-confirmation-dialog'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ExternalLink, Loader2 } from 'lucide-react'

/** Horizon testnet explorer base URL for transaction links */
const EXPLORER_BASE = 'https://stellar.expert/explorer/testnet/tx'

/** Truncate a 64-char hex hash to a readable short form, e.g. "a1b2c3d4…e5f6a7b8" */
function shortHash(hash: string): string {
  if (!hash || hash.length < 16) return hash
  return `${hash.slice(0, 8)}…${hash.slice(-8)}`
}

export function DonationTracker({ campaignId }: { campaignId: string }) {
  const {
    donations,
    loading,
    error,
    trackDonation,
    refresh,
    donationState,
    feeConfirmed,
    feeDismissed,
  } = useDonations(campaignId)

  const [amount, setAmount] = useState('')

  const handleDonate = async () => {
    if (!amount) return
    const parsed = parseFloat(amount)
    if (isNaN(parsed) || parsed < 0.0000001) return

    const result = await trackDonation(parsed)
    if (result.success) {
      setAmount('')
      refresh()
    }
  }

  const isProcessing =
    donationState.status !== 'idle' &&
    donationState.status !== 'success' &&
    donationState.status !== 'error' &&
    donationState.status !== 'awaiting-confirmation'

  return (
    <div className="space-y-6">
      {/* Fee confirmation dialog */}
      <FeeConfirmationDialog
        open={donationState.status === 'awaiting-confirmation'}
        estimatedFeeXlm={donationState.estimatedFee}
        donationAmountXlm={parseFloat(amount || '0')}
        onConfirm={feeConfirmed}
        onCancel={feeDismissed}
      />

      <Card className="p-6">
        <h3 className="text-lg font-semibold mb-4">Make a Donation</h3>
        <div className="flex gap-4">
          <Input
            type="number"
            placeholder="Amount (XLM, min 0.0000001)"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            min="0.0000001"
            step="0.0000001"
            className="max-w-xs"
            disabled={isProcessing}
          />
          <Button onClick={handleDonate} disabled={loading || isProcessing || !amount}>
            {isProcessing ? (
              <span className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Processing…
              </span>
            ) : (
              'Donate'
            )}
          </Button>
        </div>
        {error && <p className="text-red-500 mt-2 text-sm">{error}</p>}
      </Card>

      <Card className="p-6">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold">Recent Donations</h3>
          <Badge variant="secondary">{donations.length} total</Badge>
        </div>

        {loading && !donations.length ? (
          <p className="text-muted-foreground">Loading donations…</p>
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
                  <TableCell className="font-mono">
                    {donation.donor.length > 12
                      ? `${donation.donor.slice(0, 8)}…`
                      : donation.donor}
                  </TableCell>
                  <TableCell>{donation.amount} XLM</TableCell>
                  <TableCell>{new Date(donation.timestamp).toLocaleDateString()}</TableCell>
                  <TableCell className="font-mono">
                    {/* Only render an explorer link for real 64-char hashes */}
                    {/^[a-f0-9]{64}$/i.test(donation.transactionHash) ? (
                      <a
                        href={`${EXPLORER_BASE}/${donation.transactionHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                        title={donation.transactionHash}
                      >
                        {shortHash(donation.transactionHash)}
                        <ExternalLink className="h-3 w-3 shrink-0" />
                      </a>
                    ) : (
                      <span className="text-muted-foreground" title={donation.transactionHash}>
                        {shortHash(donation.transactionHash)}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  )
}
