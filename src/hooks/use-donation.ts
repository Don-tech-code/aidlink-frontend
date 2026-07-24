/**
 * useDonation(campaignId) — Real Stellar donation flow
 *
 * State machine:
 *   idle → fetching-fee → awaiting-confirmation → signing → submitting → polling → success | error
 *
 * Dual-write: one Stellar payment operation + one invokeContractFunction("record_donation")
 * in a single transaction envelope.
 */

import { useCallback, useRef, useState } from 'react'
import {
  Asset,
  BASE_FEE,
  Operation,
  SorobanRpc,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'
import { signTransaction } from '@stellar/freighter-api'
import { CONTRACT_IDS, SOROBAN_NETWORKS } from '@/config/constants'
import { useWalletStore } from '@/store/wallet-store'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DonationState {
  status:
    | 'idle'
    | 'fetching-fee'
    | 'awaiting-confirmation'
    | 'signing'
    | 'submitting'
    | 'polling'
    | 'success'
    | 'error'
  /** Estimated total fee in XLM (BASE_FEE + minResourceFee) */
  estimatedFee: number | null
  /** 64-character lowercase hex transaction hash, no 0x prefix */
  txHash: string | null
  error: string | null
  isDuplicate: boolean
}

export interface UseDonationResult {
  state: DonationState
  donate: (amountXLM: number) => Promise<void>
  reset: () => void
  feeConfirmed: () => void
  feeDismissed: () => void
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/** Thrown when the wallet is not connected so callers can redirect to /auth */
export class WalletNotConnectedError extends Error {
  readonly code = 'WALLET_NOT_CONNECTED' as const
  constructor() {
    super('Wallet is not connected')
    this.name = 'WalletNotConnectedError'
  }
}

/**
 * Carries a message that is ALREADY user-friendly (e.g. built by mapResultCode,
 * decodeResultXdr, or a known failure path below). classifyDonationError()
 * passes these through untouched instead of re-classifying them.
 */
export class DonationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DonationError'
  }
}

/**
 * Turn *any* error thrown/rejected during the donation flow into a single,
 * user-friendly sentence — never leak raw SDK/network/XDR text into the UI.
 *
 * - DonationError → already-friendly message, pass through
 * - Wallet signing was cancelled/declined → friendly "you cancelled" message
 * - Wallet extension missing/locked → friendly install/unlock message
 * - Network/connectivity failure → friendly network message
 * - Client-side timeout → friendly timeout message
 * - Anything else → generic friendly fallback (technical detail stays in the
 *   console via console.error, not in front of the user)
 */
export function classifyDonationError(err: unknown): string {
  if (err instanceof DonationError) {
    return err.message
  }

  if (err instanceof WalletNotConnectedError) {
    return 'Please connect your wallet to continue'
  }

  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const text = raw.toLowerCase()

  // Wallet extension missing, locked, or unreachable — check before the
  // generic rejection/network branches since it can mention "not installed"
  if (
    text.includes('freighter is not installed') ||
    text.includes('freighter not installed') ||
    text.includes('extension not found') ||
    (text.includes('freighter') && text.includes('not installed'))
  ) {
    return 'Freighter wallet extension not found — please install or unlock it and try again'
  }

  // Wallet signing was cancelled/declined by the user
  if (
    text.includes('declined') ||
    text.includes('denied') ||
    text.includes('reject') ||
    text.includes('not allowed') ||
    text.includes('cancelled') ||
    text.includes('canceled')
  ) {
    return 'You cancelled the request in your wallet — no funds were sent'
  }

  // Campaign escrow lookup problems — check before the generic network
  // branch, since these internal messages often also say "failed to fetch"
  if (text.includes('escrow')) {
    return "We couldn't verify this campaign's donation address — please try again or contact support"
  }

  // Fee/simulation estimation problems — same reasoning as above
  if (text.includes('simulat')) {
    return 'Unable to estimate the transaction fee right now — please try again in a moment'
  }

  // Network / connectivity failures (fetch, RPC, DNS, offline, CORS, etc.)
  if (
    text.includes('failed to fetch') ||
    text.includes('network request failed') ||
    text.includes('networkerror') ||
    text.includes('net::') ||
    text.includes('econnrefused') ||
    text.includes('econnreset') ||
    text.includes('load failed') ||
    text.includes('internet') ||
    text.includes('offline') ||
    text.includes('fetch failed')
  ) {
    return 'Network error — please check your internet connection and try again'
  }

  // Client-side timeouts distinct from the on-chain poll timeout below
  if (text.includes('timeout') || text.includes('timed out')) {
    return 'The request took too long to respond — please check your connection and try again'
  }

  // Generic fallback — never show raw SDK/XDR text to the user
  return 'Something went wrong while processing your donation — please try again'
}

// ---------------------------------------------------------------------------
// Stroop utilities  (exported so unit tests can import them directly)
// ---------------------------------------------------------------------------

/** Convert XLM to stroops (integer). 1 XLM = 10,000,000 stroops. */
export function xlmToStroops(xlm: number): bigint {
  // Round to 7 decimal places before converting to avoid floating-point drift
  return BigInt(Math.round(xlm * 10_000_000))
}

/** Convert stroops back to XLM string with exactly 7 decimal places. */
export function stroopsToXlm(stroops: number | bigint): number {
  return Number(stroops) / 10_000_000
}

/** Format a fee amount in XLM for UI display, e.g. "0.0001234 XLM" */
export function formatFeeXlm(xlm: number): string {
  return `${xlm.toFixed(7)} XLM`
}

// ---------------------------------------------------------------------------
// Idempotency map  (module-scope; persists across re-renders of the same session)
// ---------------------------------------------------------------------------

interface IdempotencyEntry {
  txHash: string
  /** Epoch ms when this entry was created */
  createdAt: number
}

/** window = 30 seconds */
const IDEMPOTENCY_WINDOW_MS = 30_000

/**
 * Key format: `${donorAddress}:${campaignId}:${Math.floor(amountXLM)}:${Math.floor(Date.now() / 30000)}`
 * The last segment rotates every 30 seconds, automatically expiring old entries.
 */
export function buildIdempotencyKey(
  donorAddress: string,
  campaignId: string,
  amountXLM: number,
): string {
  const windowSlot = Math.floor(Date.now() / IDEMPOTENCY_WINDOW_MS)
  return `${donorAddress}:${campaignId}:${Math.floor(amountXLM)}:${windowSlot}`
}

const idempotencyMap = new Map<string, IdempotencyEntry>()

function pruneExpiredEntries(): void {
  const cutoff = Date.now() - IDEMPOTENCY_WINDOW_MS
  for (const [key, entry] of idempotencyMap) {
    if (entry.createdAt < cutoff) {
      idempotencyMap.delete(key)
    }
  }
}

function checkIdempotency(key: string): string | null {
  pruneExpiredEntries()
  return idempotencyMap.get(key)?.txHash ?? null
}

function storeIdempotency(key: string, txHash: string): void {
  idempotencyMap.set(key, { txHash, createdAt: Date.now() })
}

// ---------------------------------------------------------------------------
// Error decoding
// ---------------------------------------------------------------------------

/** Map known Stellar/Soroban result codes to human-readable messages */
export function decodeTransactionError(resultMetaXdr: string): string {
  try {
    // Parse meta just to validate the XDR is well-formed
    xdr.TransactionMeta.fromXDR(resultMetaXdr, 'base64')

    const result = xdr.TransactionResult.fromXDR(resultMetaXdr, 'base64')
    const innerResult = result.result?.()
    const code = innerResult?.switch?.()?.name ?? ''
    return mapResultCode(code)
  } catch {
    return 'Transaction failed — please check your wallet balance and try again'
  }
}

/**
 * Decode from a raw TransactionResult XDR (returned by getTransaction on FAILED).
 * Accepts the resultXdr field directly.
 */
export function decodeResultXdr(resultXdr: string): string {
  try {
    const result = xdr.TransactionResult.fromXDR(resultXdr, 'base64')
    const outerCode = result.result().switch().name as string
    if (outerCode !== 'txSuccess') {
      return mapResultCode(outerCode)
    }

    // Dig into operation results
    const opResults = result.result().results?.() ?? []
    for (const opResult of opResults) {
      const opCode = opResult.tr?.()?.switch?.()?.name as string | undefined
      if (opCode) {
        const msg = mapResultCode(opCode)
        if (msg) return msg
      }
    }
    return mapResultCode(outerCode)
  } catch {
    return 'Transaction failed — please check your wallet balance and try again'
  }
}

export function mapResultCode(code: string): string {
  const MAP: Record<string, string> = {
    txINSUFFICIENT_BALANCE:
      'Insufficient XLM balance for this donation and transaction fee',
    txNO_ACCOUNT:
      'Sender account not found on the network — please fund your wallet first',
    txINSUFFICIENT_FEE:
      'Transaction fee too low — please retry; the fee will be recalculated',
    txBAD_SEQ:
      'Sequence number conflict — another transaction was submitted simultaneously; try again',
    txBAD_AUTH:
      'Transaction signature is invalid — please reconnect your wallet and retry',
    txNO_SOURCE_ACCOUNT:
      'Source account does not exist — please fund your wallet first',
    opNO_DESTINATION:
      'Campaign escrow account does not exist — contact support',
    opUNDERFUNDED:
      'Insufficient XLM balance for this donation and transaction fee',
    opLINE_FULL: 'Recipient account cannot accept this amount',
    opNO_TRUST: 'Recipient account is missing a trustline for this asset',
    opMalformed: 'Invalid operation parameters — please contact support',
  }
  return MAP[code] ?? `Transaction failed (code: ${code}) — please try again`
}

// ---------------------------------------------------------------------------
// RPC helpers
// ---------------------------------------------------------------------------

function getRpcServer(network: string): SorobanRpc.Server {
  const config =
    SOROBAN_NETWORKS[network.toUpperCase() as keyof typeof SOROBAN_NETWORKS] ??
    SOROBAN_NETWORKS.TESTNET
  return new SorobanRpc.Server(config.rpcUrl, {
    allowHttp: network === 'standalone',
  })
}

function getNetworkPassphrase(network: string): string {
  const config =
    SOROBAN_NETWORKS[network.toUpperCase() as keyof typeof SOROBAN_NETWORKS] ??
    SOROBAN_NETWORKS.TESTNET
  return config.networkPassphrase
}

// ---------------------------------------------------------------------------
// Transaction polling
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 2_000
const MAX_POLL_ATTEMPTS = 30 // 60 seconds max

async function pollForResult(
  rpc: SorobanRpc.Server,
  hash: string,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    const result = await rpc.getTransaction(hash)

    if (result.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      return hash
    }

    if (result.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      // Try to decode the failure reason
      const resultXdr = (result as SorobanRpc.Api.GetFailedTransactionResponse).resultXdr
      const msg = resultXdr ? decodeResultXdr(resultXdr.toXDR('base64')) : 'Transaction failed on-chain'
      throw new DonationError(msg)
    }

    // status === NOT_FOUND means still in flight — keep polling
  }
  throw new DonationError('Transaction timed out — it may still confirm; check your wallet history')
}

// ---------------------------------------------------------------------------
// Default state factory
// ---------------------------------------------------------------------------

function initialState(): DonationState {
  return {
    status: 'idle',
    estimatedFee: null,
    txHash: null,
    error: null,
    isDuplicate: false,
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useDonation(campaignId: string): UseDonationResult {
  const [state, setState] = useState<DonationState>(initialState)
  const wallet = useWalletStore()

  /**
   * Stores the resolver function for the fee-confirmation promise so that
   * feeConfirmed() and feeDismissed() can resolve/reject it from the UI.
   */
  const feeResolverRef = useRef<{
    resolve: () => void
    reject: (reason: string) => void
  } | null>(null)

  // ---------------------------------------------------------------------------
  // Public actions
  // ---------------------------------------------------------------------------

  const reset = useCallback(() => {
    setState(initialState())
    feeResolverRef.current = null
  }, [])

  const feeConfirmed = useCallback(() => {
    feeResolverRef.current?.resolve()
    feeResolverRef.current = null
  }, [])

  const feeDismissed = useCallback(() => {
    feeResolverRef.current?.reject('FEE_DISMISSED')
    feeResolverRef.current = null
  }, [])

  const donate = useCallback(
    async (amountXLM: number) => {
      // ------------------------------------------------------------------
      // 1. Guard: wallet connected
      // ------------------------------------------------------------------
      if (!wallet.isConnected || !wallet.publicKey) {
        throw new WalletNotConnectedError()
      }

      // ------------------------------------------------------------------
      // 2. Guard: minimum amount (1 stroop = 0.0000001 XLM)
      // ------------------------------------------------------------------
      if (amountXLM < 0.0000001) {
        setState((s) => ({
          ...s,
          status: 'error',
          error: 'Minimum donation is 0.0000001 XLM (1 stroop)',
        }))
        return
      }

      const donorAddress = wallet.publicKey
      const network = wallet.network ?? 'testnet'

      // ------------------------------------------------------------------
      // 3. Idempotency check
      // ------------------------------------------------------------------
      const idempotencyKey = buildIdempotencyKey(donorAddress, campaignId, amountXLM)
      const existingHash = checkIdempotency(idempotencyKey)
      if (existingHash) {
        setState({
          status: 'success',
          estimatedFee: null,
          txHash: existingHash,
          error: null,
          isDuplicate: true,
        })
        return
      }

      // ------------------------------------------------------------------
      // 4. Start: fetching fee
      // ------------------------------------------------------------------
      setState({
        status: 'fetching-fee',
        estimatedFee: null,
        txHash: null,
        error: null,
        isDuplicate: false,
      })

      try {
        const rpc = getRpcServer(network)
        const networkPassphrase = getNetworkPassphrase(network)

        // ----------------------------------------------------------------
        // 5. Fetch source account for sequence number
        // ----------------------------------------------------------------
        const sourceAccount = await rpc.getAccount(donorAddress)

        // ----------------------------------------------------------------
        // 6. Fetch campaign escrow address from contract
        //    Function: get_campaign_escrow(campaignId: symbol) -> address
        // ----------------------------------------------------------------
        let escrowAddress: string
        try {
          const escrowSimResult = await rpc.simulateTransaction(
            new TransactionBuilder(sourceAccount, {
              fee: BASE_FEE,
              networkPassphrase,
            })
              .addOperation(
                Operation.invokeContractFunction({
                  contract: CONTRACT_IDS.CAMPAIGN_MANAGER,
                  function: 'get_campaign_escrow',
                  args: [nativeToScVal(campaignId, { type: 'symbol' })],
                }),
              )
              .setTimeout(30)
              .build(),
          )

          if (SorobanRpc.Api.isSimulationError(escrowSimResult)) {
            console.error(
              '[useDonation] Failed to fetch campaign escrow address:',
              escrowSimResult.error,
            )
            throw new DonationError(
              "We couldn't verify this campaign's donation address — please try again or contact support",
            )
          }

          const escrowResult = escrowSimResult as SorobanRpc.Api.SimulateTransactionSuccessResponse
          if (!escrowResult.result?.retval) {
            console.error('[useDonation] Contract did not return an escrow address')
            throw new DonationError(
              "We couldn't verify this campaign's donation address — please try again or contact support",
            )
          }

          // The contract returns an Address ScVal — extract the string
          const retval = escrowResult.result.retval
          if (retval.switch().name === 'scvAddress') {
            const addrXdr = retval.address()
            // AccountId type
            if (addrXdr.switch().name === 'scAddressTypeAccount') {
              escrowAddress = addrXdr
                .accountId()
                .ed25519()
                .toString('base64') // fallback; prefer StrKey below
              // Use StrKey encoding for proper Stellar address
              const { StrKey } = await import('@stellar/stellar-sdk')
              escrowAddress = StrKey.encodeEd25519PublicKey(
                addrXdr.accountId().ed25519(),
              )
            } else {
              // Contract address — use it as-is via hex
              console.error(
                '[useDonation] Escrow address is a contract address, not a Stellar account — unsupported configuration',
              )
              throw new DonationError(
                "We couldn't verify this campaign's donation address — please try again or contact support",
              )
            }
          } else {
            console.error('[useDonation] Unexpected return type from get_campaign_escrow')
            throw new DonationError(
              "We couldn't verify this campaign's donation address — please try again or contact support",
            )
          }
        } catch (escrowErr) {
          // If the contract doesn't exist in the test environment, we still need
          // to proceed. Propagate the error so the UI can surface it.
          throw escrowErr
        }

        // ----------------------------------------------------------------
        // 7. Re-fetch account (sequence may have changed during escrow call)
        // ----------------------------------------------------------------
        const freshAccount = await rpc.getAccount(donorAddress)

        // ----------------------------------------------------------------
        // 8. Build the dual-write transaction envelope
        // ----------------------------------------------------------------
        const amountStr = amountXLM.toFixed(7) // Stellar requires 7 decimal places
        const stroops = xlmToStroops(amountXLM)

        const builtTx = new TransactionBuilder(freshAccount, {
          fee: BASE_FEE,
          networkPassphrase,
        })
          .addOperation(
            Operation.payment({
              destination: escrowAddress,
              asset: Asset.native(),
              amount: amountStr,
            }),
          )
          .addOperation(
            Operation.invokeContractFunction({
              contract: CONTRACT_IDS.CAMPAIGN_MANAGER,
              function: 'record_donation',
              args: [
                nativeToScVal(campaignId, { type: 'symbol' }),
                nativeToScVal(donorAddress, { type: 'address' }),
                nativeToScVal(stroops, { type: 'i128' }),
              ],
            }),
          )
          .setTimeout(180) // 3-minute validity window
          .build()

        // ----------------------------------------------------------------
        // 9. Simulate to get fee estimate
        // ----------------------------------------------------------------
        const simResult = await rpc.simulateTransaction(builtTx)

        if (SorobanRpc.Api.isSimulationError(simResult)) {
          console.error('[useDonation] Transaction simulation failed:', simResult.error)
          throw new DonationError(
            'Unable to estimate the transaction fee right now — please check your balance and try again',
          )
        }

        const successSim = simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse
        const minResourceFee = parseInt(successSim.minResourceFee ?? '0', 10)
        const totalFeeStroops = parseInt(BASE_FEE, 10) + minResourceFee
        const totalFeeXlm = stroopsToXlm(totalFeeStroops)

        // ----------------------------------------------------------------
        // 10. Present fee to user — suspend until confirmed or dismissed
        // ----------------------------------------------------------------
        setState((s) => ({
          ...s,
          status: 'awaiting-confirmation',
          estimatedFee: totalFeeXlm,
        }))

        await new Promise<void>((resolve, reject) => {
          feeResolverRef.current = { resolve, reject }
        })
        // If we reach here, the user confirmed the fee

        // ----------------------------------------------------------------
        // 11. Prepare transaction (applies resource fees to envelope)
        // ----------------------------------------------------------------
        setState((s) => ({ ...s, status: 'signing' }))

        const preparedTx = SorobanRpc.assembleTransaction(builtTx, simResult).build()

        // ----------------------------------------------------------------
        // 12. Sign via Freighter
        // ----------------------------------------------------------------
        const preparedXdr = preparedTx.toEnvelope().toXDR('base64')

        let signResult: Awaited<ReturnType<typeof signTransaction>>
        try {
          signResult = await signTransaction(preparedXdr, {
            networkPassphrase,
            address: donorAddress,
          })
        } catch (signErr) {
          // Freighter throws directly when the user closes/declines the popup
          // or the extension is missing/locked — classify rather than leak
          console.error('[useDonation] signTransaction threw:', signErr)
          throw new DonationError(classifyDonationError(signErr))
        }

        // signTransaction returns either a string XDR or { signedTxXdr, error }
        if (typeof signResult !== 'string' && signResult.error) {
          console.error('[useDonation] Freighter returned a sign error:', signResult.error)
          throw new DonationError(classifyDonationError(new Error(String(signResult.error))))
        }

        const signedXdr =
          typeof signResult === 'string' ? signResult : signResult.signedTxXdr

        if (!signedXdr) {
          console.error('[useDonation] Freighter returned no signed transaction')
          throw new DonationError('You cancelled the request in your wallet — no funds were sent')
        }

        // ----------------------------------------------------------------
        // 13. Submit
        // ----------------------------------------------------------------
        setState((s) => ({ ...s, status: 'submitting' }))

        const { TransactionBuilder: TB } = await import('@stellar/stellar-sdk')
        const signedTx = TB.fromXDR(signedXdr, networkPassphrase)

        const sendResult = await rpc.sendTransaction(signedTx)

        if (sendResult.status === 'ERROR') {
          const errXdr = sendResult.errorResult?.toXDR('base64')
          const msg = errXdr ? decodeResultXdr(errXdr) : 'Transaction rejected by the network'
          throw new DonationError(msg)
        }

        const txHash = sendResult.hash

        // ----------------------------------------------------------------
        // 14. Poll for confirmation
        // ----------------------------------------------------------------
        setState((s) => ({ ...s, status: 'polling', txHash }))

        await pollForResult(rpc, txHash)

        // ----------------------------------------------------------------
        // 15. Success
        // ----------------------------------------------------------------
        storeIdempotency(idempotencyKey, txHash)

        setState({
          status: 'success',
          estimatedFee: totalFeeXlm,
          txHash,
          error: null,
          isDuplicate: false,
        })
      } catch (err: unknown) {
        // Fee dismissed is an expected cancellation — return to idle
        if (err === 'FEE_DISMISSED') {
          setState(initialState())
          return
        }

        // Keep the raw/technical error in the console for debugging, but
        // never show it to the user — always surface a friendly message.
        console.error('[useDonation] donation failed:', err)
        const message = classifyDonationError(err)

        setState((s) => ({
          ...s,
          status: 'error',
          error: message,
        }))
      }
    },
    [campaignId, wallet],
  )

  return { state, donate, reset, feeConfirmed, feeDismissed }
}
