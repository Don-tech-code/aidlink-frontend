'use client'

/**
 * FeeConfirmationDialog
 *
 * A non-dismissible dialog that presents the estimated transaction fee to the
 * donor before any signing occurs. The dialog CANNOT be closed by pressing
 * Escape or clicking outside it — the user must explicitly confirm or cancel.
 *
 * This is intentional UX: we want the user to make an explicit, informed
 * decision about the fee rather than accidentally dismissing it.
 */

import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

// ---------------------------------------------------------------------------
// Internal primitives — override the standard shadcn DialogContent so that
// Escape and pointer-down-outside events are intercepted.
// ---------------------------------------------------------------------------

const FeeDialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-background/80 backdrop-blur-sm',
      'data-[state=open]:animate-in data-[state=closed]:animate-out',
      'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className,
    )}
    {...props}
  />
))
FeeDialogOverlay.displayName = 'FeeDialogOverlay'

interface FeeDialogContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /** Prevent all implicit-close triggers */
  forceOpen?: boolean
}

const FeeDialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  FeeDialogContentProps
>(({ className, children, forceOpen = true, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <FeeDialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      /**
       * Intercept all implicit-dismiss events so the dialog stays open until
       * the user presses "Confirm" or "Cancel" explicitly.
       */
      onEscapeKeyDown={(e) => {
        if (forceOpen) e.preventDefault()
      }}
      onPointerDownOutside={(e) => {
        if (forceOpen) e.preventDefault()
      }}
      onInteractOutside={(e) => {
        if (forceOpen) e.preventDefault()
      }}
      onOpenAutoFocus={(e) => e.preventDefault()}
      className={cn(
        'fixed left-[50%] top-[50%] z-50 grid w-full max-w-md',
        'translate-x-[-50%] translate-y-[-50%] gap-4',
        'border bg-background p-6 shadow-lg duration-200 sm:rounded-lg',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        'data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%]',
        'data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]',
        className,
      )}
      {...props}
    >
      {children}
      {/* Intentionally no close (X) button — this dialog is non-dismissible */}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
))
FeeDialogContent.displayName = 'FeeDialogContent'

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface FeeConfirmationDialogProps {
  /** Whether the dialog is visible */
  open: boolean
  /** Estimated total fee in XLM */
  estimatedFeeXlm: number | null
  /** Amount being donated in XLM */
  donationAmountXlm: number
  /** Called when the user explicitly confirms */
  onConfirm: () => void
  /** Called when the user explicitly cancels */
  onCancel: () => void
}

export function FeeConfirmationDialog({
  open,
  estimatedFeeXlm,
  donationAmountXlm,
  onConfirm,
  onCancel,
}: FeeConfirmationDialogProps) {
  const feeStr =
    estimatedFeeXlm !== null ? estimatedFeeXlm.toFixed(7) : 'Calculating...'
  const totalStr =
    estimatedFeeXlm !== null
      ? (donationAmountXlm + estimatedFeeXlm).toFixed(7)
      : '...'

  return (
    <DialogPrimitive.Root open={open} onOpenChange={() => {}}>
      <FeeDialogContent aria-describedby="fee-dialog-description">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/30">
            <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
          </div>
          <div>
            <DialogPrimitive.Title className="text-lg font-semibold">
              Confirm Transaction Fee
            </DialogPrimitive.Title>
            <DialogPrimitive.Description
              id="fee-dialog-description"
              className="text-sm text-muted-foreground"
            >
              Review the fee before your donation is signed and submitted.
            </DialogPrimitive.Description>
          </div>
        </div>

        {/* Fee breakdown */}
        <div className="rounded-lg border bg-muted/40 p-4 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Donation amount</span>
            <span className="font-mono font-medium">
              {donationAmountXlm.toFixed(7)} XLM
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Network fee (estimated)</span>
            {estimatedFeeXlm === null ? (
              <span className="flex items-center gap-1 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Calculating…
              </span>
            ) : (
              <span className="font-mono font-medium">{feeStr} XLM</span>
            )}
          </div>
          <div className="border-t pt-2 flex justify-between font-semibold">
            <span>Total deducted from wallet</span>
            <span className="font-mono">{totalStr} XLM</span>
          </div>
        </div>

        {/* Info note */}
        <p className="text-xs text-muted-foreground">
          The network fee goes to Stellar validators. AidLink does not receive
          any portion of it. The fee is typically well under 0.001 XLM on
          testnet.
        </p>

        {/* Actions */}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            onClick={onCancel}
            className="gap-2"
            disabled={estimatedFeeXlm === null}
          >
            <XCircle className="h-4 w-4" />
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            className="gap-2"
            disabled={estimatedFeeXlm === null}
          >
            <CheckCircle2 className="h-4 w-4" />
            Confirm &amp; Sign
          </Button>
        </div>
      </FeeDialogContent>
    </DialogPrimitive.Root>
  )
}
