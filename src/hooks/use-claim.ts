/**
 * useClaim(allocation, claimToken)
 *
 * Full Soroban claim state machine for a single allocation:
 *
 *   idle
 *     ↓  startClaim()
 *   fetching-fee      ← validates token, calls simulateClaim()
 *     ↓  feeConfirmed()
 *   awaiting-confirmation  ← user sees fee dialog
 *     ↓
 *   signing           ← calls signTransaction() via Freighter
 *     ↓
 *   submitting        ← calls rpc.sendTransaction()
 *     ↓
 *   polling           ← polls getTransaction() with exponential backoff
 *     ↓
 *   success | error | already-claimed | token-expired | not-your-claim
 *
 * None of these steps use setTimeout as a mock — every transition is driven
 * by a real Soroban RPC response.
 *
 * The hook is stable across re-renders (all functions are wrapped in
 * useCallback) and the state machine prevents concurrent calls.
 */

import { useCallback, useRef, useState } from 'react'
import {
  SorobanRpc,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import { signTransaction } from '@stellar/freighter-api'
import { SOROBAN_NETWORKS } from '@/config/constants'
import { useWalletStore } from '@/store/wallet-store'
import {
  isTokenExpiredSync,
  stroopsToXlm,
  formatClaimFeeXlm,
} from '@/lib/beneficiary/claim-token'
import {
  simulateClaim,
  AlreadyClaimedError,
  VerificationRequiredError,
  AllocationsContractNotConfiguredError,
} from '@/lib/beneficiary/allocations'
import type { Allocation, ClaimState, ClaimStatus, ClaimTokenValidation } from '@/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseClaimResult {
  /** Current state of the claim machine for this allocation */
  state: ClaimState
  /**
   * Start the claim flow.
   * Validates the token, fetches fee, then transitions to awaiting-confirmation.
   * Must only be called when state.status === 'idle'.
   */
  startClaim: () => Promise<void>
  /** Call when the user accepts the fee dialog. Triggers signing + submit. */
  feeConfirmed: () => void
  /** Call when the user dismisses/cancels the fee dialog. Resets to idle. */
  feeDismissed: () => void
  /** Reset the state machine back to idle. */
  reset: () => void
}

// ---------------------------------------------------------------------------
// RPC helpers
// ---------------------------------------------------------------------------

function getRpcServer(network: string): SorobanRpc.Server {
  const key = network.toUpperCase() as keyof typeof SOROBAN_NETWORKS
  const config = SOROBAN_NETWORKS[key] ?? SOROBAN_NETWORKS.TESTNET
  return new SorobanRpc.Server(config.rpcUrl, {
    allowHttp: network === 'standalone',
  })
}

function getNetworkPassphrase(network: string): string {
  const key = network.toUpperCase() as keyof typeof SOROBAN_NETWORKS
  const config = SOROBAN_NETWORKS[key] ?? SOROBAN_NETWORKS.TESTNET
  return config.networkPassphrase
}

// ---------------------------------------------------------------------------
// Server-side token validation
// ---------------------------------------------------------------------------

/**
 * Validate a claim token by POSTing it to the server route.
 *
 * Signature verification needs the HMAC secret, which now lives only on the
 * server (claim-token.server.ts). Routing validation through the API keeps the
 * secret out of the browser bundle while preserving the exact
 * {@link ClaimTokenValidation} contract the state machine consumed when
 * validation ran locally.
 */
async function postValidateClaimToken(
  tokenString: string,
  connectedAddress: string,
): Promise<ClaimTokenValidation> {
  const res = await fetch('/api/v1/claim-token/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: tokenString, connectedAddress }),
  })
  if (!res.ok) {
    throw new Error(`Claim token validation request failed (${res.status})`)
  }
  return (await res.json()) as ClaimTokenValidation
}

// ---------------------------------------------------------------------------
// Error classifier
// ---------------------------------------------------------------------------

/**
 * Map any thrown error into a { status, message } pair for the state machine.
 * Never exposes raw SDK/XDR internals to the UI.
 */
function classifyClaimError(err: unknown): { status: ClaimStatus; message: string } {
  if (err instanceof AlreadyClaimedError) {
    return { status: 'already-claimed', message: 'This allocation was already claimed.' }
  }
  if (err instanceof VerificationRequiredError) {
    return {
      status: 'error',
      message:
        'Your identity must be verified before claiming aid. Complete verification and wait for approval.',
    }
  }
  if (err instanceof AllocationsContractNotConfiguredError) {
    return {
      status: 'error',
      message:
        'The claim contract is not configured. Contact support.',
    }
  }

  if (!(err instanceof Error)) {
    return { status: 'error', message: 'An unexpected error occurred — please try again.' }
  }

  const text = err.message.toLowerCase()

  // Wallet extension missing or locked
  if (
    text.includes('freighter is not installed') ||
    text.includes('freighter not installed') ||
    text.includes('extension not found') ||
    (text.includes('freighter') && text.includes('not installed'))
  ) {
    return {
      status: 'error',
      message: 'Freighter wallet extension not found — please install or unlock it and try again.',
    }
  }

  // User cancelled
  if (
    text.includes('declined') ||
    text.includes('denied') ||
    text.includes('reject') ||
    text.includes('not allowed') ||
    text.includes('cancelled') ||
    text.includes('canceled')
  ) {
    return {
      status: 'idle',
      message: 'You cancelled the request in your wallet — no transaction was submitted.',
    }
  }

  // Already claimed (caught via message text as fallback)
  if (
    text.includes('already_claimed') ||
    text.includes('already claimed') ||
    text.includes('alreadyclaimed') ||
    text.includes('double claim') ||
    text.includes('duplicate claim')
  ) {
    return { status: 'already-claimed', message: 'This allocation was already claimed.' }
  }

  // Network errors
  if (
    text.includes('failed to fetch') ||
    text.includes('network request failed') ||
    text.includes('networkerror') ||
    text.includes('econnrefused') ||
    text.includes('fetch failed') ||
    text.includes('offline')
  ) {
    return {
      status: 'error',
      message: 'Network error — please check your internet connection and try again.',
    }
  }

  // Insufficient balance
  if (
    text.includes('insufficient') ||
    text.includes('underfunded') ||
    text.includes('txinsufficient_balance')
  ) {
    return {
      status: 'error',
      message: 'Insufficient XLM balance to cover the transaction fee.',
    }
  }

  // Transaction timed out
  if (text.includes('timed out') || text.includes('timeout')) {
    return {
      status: 'error',
      message: 'Transaction timed out — it may still confirm. Check your wallet history.',
    }
  }

  // On-chain failure with decoded reason
  if (text.includes('transaction failed')) {
    return { status: 'error', message: err.message }
  }

  // Generic fallback
  return { status: 'error', message: 'Something went wrong while processing your claim — please try again.' }
}

// ---------------------------------------------------------------------------
// Transaction result decoding
// ---------------------------------------------------------------------------

/**
 * Decode a FAILED transaction's XDR into a user-friendly message.
 */
function decodeFailedTransaction(
  result: SorobanRpc.Api.GetFailedTransactionResponse,
): string {
  try {
    const xdrBase64 = result.resultXdr?.toXDR('base64')
    if (!xdrBase64) return 'Transaction failed on-chain.'

    const txResult = xdr.TransactionResult.fromXDR(xdrBase64, 'base64')
    const outerCode = txResult.result().switch().name as string

    // Map common codes
    const messages: Record<string, string> = {
      txINSUFFICIENT_BALANCE: 'Insufficient XLM balance for the transaction fee.',
      txBAD_SEQ: 'Sequence number conflict — please retry.',
      txBAD_AUTH: 'Transaction signature is invalid — please reconnect your wallet.',
      txNO_ACCOUNT: 'Your account was not found on the network.',
    }
    return messages[outerCode] ?? `Transaction failed on-chain (${outerCode}).`
  } catch {
    return 'Transaction failed on-chain.'
  }
}

// ---------------------------------------------------------------------------
// Polling  (exponential backoff, matching the pattern in contract.ts)
// ---------------------------------------------------------------------------

const MAX_BACKOFF_MS = 16_000
const MAX_POLL_RETRIES = 8

/**
 * Override the per-attempt delay in milliseconds.
 * For test use only — pass 0 to make polling instant.
 */
let _pollDelayOverrideMs: number | null = null
/** @internal test-only */
export function __setPollDelayMs(ms: number | null): void {
  _pollDelayOverrideMs = ms
}

/**
 * Poll for transaction confirmation with exponential backoff.
 * Returns the 64-char hex transaction hash on SUCCESS.
 * Throws a descriptive Error on FAILED or timeout.
 */
async function pollForConfirmation(
  rpc: SorobanRpc.Server,
  hash: string,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_POLL_RETRIES; attempt++) {
    const delay =
      _pollDelayOverrideMs !== null
        ? _pollDelayOverrideMs
        : Math.min(1_000 * Math.pow(2, attempt), MAX_BACKOFF_MS)
    await new Promise((r) => setTimeout(r, delay))

    const result = await rpc.getTransaction(hash)

    if (result.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      return hash
    }

    if (result.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      const msg = decodeFailedTransaction(
        result as SorobanRpc.Api.GetFailedTransactionResponse,
      )
      throw new Error(msg)
    }
    // NOT_FOUND → still in flight, keep polling
  }
  throw new Error(
    'Transaction timed out — it may still confirm. Check your wallet history.',
  )
}

// ---------------------------------------------------------------------------
// Initial state factory
// ---------------------------------------------------------------------------

function makeInitialState(): ClaimState {
  return {
    status: 'idle',
    estimatedFeeXlm: null,
    txHash: null,
    error: null,
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useClaim(
  allocation: Allocation,
  claimToken: string,
): UseClaimResult {
  const { address, network } = useWalletStore()

  const [state, setState] = useState<ClaimState>(makeInitialState)

  /**
   * Internal ref to hold the prepared transaction XDR between the
   * fetching-fee → awaiting-confirmation → signing transitions.
   * We use a ref (not state) because changing it must not trigger a re-render.
   */
  const preparedTxXdrRef = useRef<string | null>(null)

  // -------------------------------------------------------------------------
  // Step 1: startClaim — validate token, simulate fee
  // -------------------------------------------------------------------------

  const startClaim = useCallback(async () => {
    // Guard: only run from idle
    if (state.status !== 'idle') return

    // Guard: wallet must be connected
    if (!address) {
      setState({
        status: 'error',
        estimatedFeeXlm: null,
        txHash: null,
        error: 'Wallet not connected. Please connect your wallet to claim aid.',
      })
      return
    }

    setState({
      status: 'fetching-fee',
      estimatedFeeXlm: null,
      txHash: null,
      error: null,
    })

    try {
      // 1a. Quick sync expiry check (no crypto needed)
      if (isTokenExpiredSync(claimToken)) {
        setState({
          status: 'token-expired',
          estimatedFeeXlm: null,
          txHash: null,
          error: 'This claim token has expired. Refresh the page for a new one.',
        })
        return
      }

      // 1b. Full async validation (HMAC + address match) runs on the server,
      //     where the signing secret lives — never in the browser bundle.
      const validation = await postValidateClaimToken(claimToken, address)

      if (!validation.valid) {
        if (validation.reason === 'expired') {
          setState({
            status: 'token-expired',
            estimatedFeeXlm: null,
            txHash: null,
            error: validation.message,
          })
          return
        }
        if (validation.reason === 'wrong-address') {
          setState({
            status: 'not-your-claim',
            estimatedFeeXlm: null,
            txHash: null,
            error: validation.message,
          })
          return
        }
        // malformed or invalid-signature
        setState({
          status: 'error',
          estimatedFeeXlm: null,
          txHash: null,
          error: validation.message,
        })
        return
      }

      // 1c. Simulate claim to get fee + prepared TX XDR
      const { feeStroops, preparedTxXdr } = await simulateClaim(
        allocation.claimId,
        address,
        network,
      )

      preparedTxXdrRef.current = preparedTxXdr

      setState({
        status: 'awaiting-confirmation',
        estimatedFeeXlm: stroopsToXlm(feeStroops),
        txHash: null,
        error: null,
      })
    } catch (err) {
      const { status, message } = classifyClaimError(err)
      setState({
        status,
        estimatedFeeXlm: null,
        txHash: null,
        error: message,
      })
    }
  }, [state.status, address, claimToken, allocation.claimId, network])

  // -------------------------------------------------------------------------
  // Step 2: feeConfirmed — sign → submit → poll
  // -------------------------------------------------------------------------

  const feeConfirmed = useCallback(async () => {
    if (state.status !== 'awaiting-confirmation') return

    const preparedTxXdr = preparedTxXdrRef.current
    if (!preparedTxXdr || !address) {
      setState((prev) => ({
        ...prev,
        status: 'error',
        error: 'Transaction data was lost — please start the claim again.',
      }))
      return
    }

    // ── signing ──
    setState((prev) => ({ ...prev, status: 'signing' }))

    const networkPassphrase = getNetworkPassphrase(network)
    let signedXdr: string

    try {
      const signResult = await signTransaction(preparedTxXdr, {
        networkPassphrase,
        address,
      })
      signedXdr =
        typeof signResult === 'string' ? signResult : signResult.signedTxXdr
    } catch (err) {
      const { status, message } = classifyClaimError(err)
      // If status is 'idle' the user just cancelled — reset to idle
      setState((prev) => ({
        ...prev,
        status: status === 'idle' ? 'idle' : 'error',
        error: status === 'idle' ? null : message,
      }))
      return
    }

    // ── submitting ──
    setState((prev) => ({ ...prev, status: 'submitting' }))

    const rpc = getRpcServer(network)

    let txHash: string
    try {
      const signedTx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase)
      const sendResult = await rpc.sendTransaction(signedTx)

      if (sendResult.status === 'ERROR') {
        const xdrBase64 = sendResult.errorResult?.toXDR('base64')
        throw new Error(
          xdrBase64
            ? `Transaction rejected by the network (${xdrBase64})`
            : 'Transaction rejected by the network.',
        )
      }

      txHash = sendResult.hash
    } catch (err) {
      const { message } = classifyClaimError(err)
      setState((prev) => ({
        ...prev,
        status: 'error',
        error: message,
      }))
      return
    }

    // ── polling ──
    setState((prev) => ({ ...prev, status: 'polling' }))

    try {
      await pollForConfirmation(rpc, txHash)

      setState({
        status: 'success',
        estimatedFeeXlm: state.estimatedFeeXlm,
        txHash,
        error: null,
      })
    } catch (err) {
      // Check if it's a specific "already claimed" on-chain response
      const { status, message } = classifyClaimError(err)
      setState({
        status,
        estimatedFeeXlm: state.estimatedFeeXlm,
        txHash: null,
        error: message,
      })
    }
  }, [state.status, state.estimatedFeeXlm, address, network])

  // -------------------------------------------------------------------------
  // feeDismissed — user rejected the fee dialog
  // -------------------------------------------------------------------------

  const feeDismissed = useCallback(() => {
    if (state.status !== 'awaiting-confirmation') return
    preparedTxXdrRef.current = null
    setState(makeInitialState)
  }, [state.status])

  // -------------------------------------------------------------------------
  // reset
  // -------------------------------------------------------------------------

  const reset = useCallback(() => {
    preparedTxXdrRef.current = null
    setState(makeInitialState)
  }, [])

  return {
    state,
    startClaim,
    feeConfirmed,
    feeDismissed,
    reset,
  }
}

// ---------------------------------------------------------------------------
// Re-exports for test and UI convenience
// ---------------------------------------------------------------------------

export { formatClaimFeeXlm, stroopsToXlm }
