'use client'

import React from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { formatClaimFeeXlm } from '@/lib/beneficiary/claim-token'

interface FeeConfirmationDialogProps {
  open: boolean
  estimatedFeeXlm: number | null
  allocationAmount: string // formatted XLM string, e.g. "10.0000000 XLM"
  onConfirm: () => void
  onDismiss: () => void
}

export function FeeConfirmationDialog({
  open,
  estimatedFeeXlm,
  allocationAmount,
  onConfirm,
  onDismiss,
}: FeeConfirmationDialogProps) {
  const feeDisplay =
    estimatedFeeXlm !== null
      ? formatClaimFeeXlm(estimatedFeeXlm)
      : 'Calculating…'

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onDismiss() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm Claim Transaction</DialogTitle>
          <DialogDescription>
            Review the transaction fee before signing with your wallet.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Aid amount</span>
            <span className="font-medium">{allocationAmount}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Estimated network fee</span>
            <span className="font-medium font-mono">{feeDisplay}</span>
          </div>
          <p className="text-xs text-muted-foreground pt-1">
            The fee is deducted from your wallet balance, not from the aid amount.
            Your wallet will ask you to sign before anything is submitted.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onDismiss}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={estimatedFeeXlm === null}>
            Sign &amp; Submit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
