/**
 * useDonation(campaignId) — Real Stellar donation flow
 *
 * State machine:
 *   idle → fetching-fee → awaiting-confirmation → signing → submitting → polling → success | error
 *
 * Dual-write: one Stellar payment operation + one invokeContractFunction("record_donation")
 * in a single transaction envelope.
 *
 * Issue #139 — partial-success / split-brain recovery:
 *   - The idempotency entry for (donor, campaign, amount, window) is created
 *     OPTIMISTICALLY the instant donate() is called, before any network I/O.
 *     A concurrent donate() call for the same key attaches to that entry's
 *     promise instead of building a second envelope, so double-submits
 *     (Scenario B) are prevented at the source rather than detected after
 *     the fact.
 *   - A deterministic nonce derived from the idempotency key is passed to
 *     record_donation as a trailing argument so the contract has the raw
 *     material to enforce its own idempotency if/when it's updated to do so.
 *   - pollForResult performs one extra getTransaction probe after its
 *     client-side timeout elapses (Scenario A) before giving up, since
 *     Soroban RPC retains results for ~10 ledgers after submission.
 *   - A txBadSeq submission error triggers a silent re-fetch-and-retry
 *     loop (Scenario D), up to MAX_SEQ_RETRY_ATTEMPTS, instead of
 *     surfacing an error to the donor immediately.
 *   - decodeResultXdr walks the actual OperationResult/PaymentResult XDR
 *     union so a payment failure (Scenario C) is reported with the right
 *     specific reason instead of a generic operation-type name.
 */

import { useCallback, useRef, useState } from 'react'
import {
  Account,
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
// Idempotency
// ---------------------------------------------------------------------------
//
// The idempotency slot for a (donor, campaign, amount, window) key is
// claimed OPTIMISTICALLY, before any network call is made, and lives for the
// whole in-flight lifetime of the donation:
//
//   pending  --success-->  committed  (persisted to sessionStorage)
//            --failure-->  (slot freed; a fresh attempt is allowed)
//
// A concurrent donate() call for the same key finds the pending entry and
// awaits its promise instead of submitting a second transaction, which is
// what actually prevents Scenario B (the double-submit race) rather than
// merely detecting it after the fact.

interface IdempotencyEntry {
  status: 'pending' | 'committed'
  txHash: string | null
  createdAt: number
  promise: Promise<string>
  resolve: (txHash: string) => void
  reject: (err: unknown) => void
}

/** window = 30 seconds — but see IDEMPOTENCY_WINDOW_MS below, which must be
 * at least as long as the maximum poll duration (60s) per issue #139. */
const IDEMPOTENCY_WINDOW_MS = 60_000

/**
 * Key format: `${donorAddress}:${campaignId}:${Math.floor(amountXLM)}:${Math.floor(Date.now() / 60000)}`
 * The last segment rotates every IDEMPOTENCY_WINDOW_MS, automatically expiring old entries.
 */
export function buildIdempotencyKey(
  donorAddress: string,
  campaignId: string,
  amountXLM: number,
): string {
  const windowSlot = Math.floor(Date.now() / IDEMPOTENCY_WINDOW_MS)
  return `${donorAddress}:${campaignId}:${Math.floor(amountXLM)}:${windowSlot}`
}

/**
 * Deterministic, client-generated nonce derived from the idempotency key.
 * Passed to record_donation as a trailing argument so the contract has the
 * raw material to enforce on-chain idempotency (Scenario B) if/when it is
 * updated to accept it. Same key always produces the same nonce, and
 * different keys are extremely unlikely to collide (32-bit FNV-1a over the
 * full key, hex-encoded).
 */
export function generateDonationNonce(idempotencyKey: string): string {
  // FNV-1a, 32-bit. Deterministic, dependency-free, sufficient entropy for
  // a same-window dedupe hint (this is not a cryptographic nonce).
  let hash = 0x811c9dc5
  for (let i = 0; i < idempotencyKey.length; i++) {
    hash ^= idempotencyKey.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

const idempotencyMap = new Map<string, IdempotencyEntry>()

/**
 * Clears all idempotency state (in-memory + sessionStorage). Test-only —
 * production code has no legitimate reason to wipe this mid-session.
 * @internal test-only
 */
export function __resetDonationIdempotencyState(): void {
  idempotencyMap.clear()
  if (typeof sessionStorage !== 'undefined') {
    try {
      const keysToRemove: string[] = []
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i)
        if (key?.startsWith('aidlink:donation-idempotency:')) {
          keysToRemove.push(key)
        }
      }
      keysToRemove.forEach((key) => sessionStorage.removeItem(key))
    } catch {
      // sessionStorage unavailable — nothing to clear
    }
  }
}

function idempotencyStorageKey(key: string): string {
  return `aidlink:donation-idempotency:${key}`
}

function readPersistedCommitted(key: string): string | null {
  if (typeof sessionStorage === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(idempotencyStorageKey(key))
    if (!raw) return null
    const parsed = JSON.parse(raw) as { txHash: string; createdAt: number }
    if (Date.now() - parsed.createdAt > IDEMPOTENCY_WINDOW_MS) {
      sessionStorage.removeItem(idempotencyStorageKey(key))
      return null
    }
    return parsed.txHash
  } catch {
    return null
  }
}

function persistCommitted(key: string, txHash: string): void {
  if (typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.setItem(
      idempotencyStorageKey(key),
      JSON.stringify({ txHash, createdAt: Date.now() }),
    )
  } catch {
    // sessionStorage unavailable/full — the in-memory map still protects
    // same-tab races within this page load.
  }
}

function pruneExpiredEntries(): void {
  const cutoff = Date.now() - IDEMPOTENCY_WINDOW_MS
  for (const [key, entry] of idempotencyMap) {
    if (entry.status === 'committed' && entry.createdAt < cutoff) {
      idempotencyMap.delete(key)
    }
  }
}

type IdempotencyClaim =
  | { kind: 'new'; entry: IdempotencyEntry }
  | { kind: 'duplicate'; promise: Promise<string> }

/**
 * Attempts to claim the idempotency slot for `key`. Returns `{ kind: 'new' }`
 * if this caller is the first to reach this key in the current window (the
 * caller is responsible for eventually calling settleIdempotencySuccess or
 * settleIdempotencyFailure on the returned entry). Returns
 * `{ kind: 'duplicate' }` if another call already owns the slot (in-flight
 * or already committed, including entries persisted from an earlier page
 * load in this tab) — the caller should await the returned promise instead
 * of submitting a new transaction.
 */
function claimIdempotencySlot(key: string): IdempotencyClaim {
  pruneExpiredEntries()

  const existing = idempotencyMap.get(key)
  if (existing) {
    return { kind: 'duplicate', promise: existing.promise }
  }

  const persistedHash = readPersistedCommitted(key)
  if (persistedHash) {
    return { kind: 'duplicate', promise: Promise.resolve(persistedHash) }
  }

  let resolveFn!: (txHash: string) => void
  let rejectFn!: (err: unknown) => void
  const promise = new Promise<string>((resolve, reject) => {
    resolveFn = resolve
    rejectFn = reject
  })
  // A pending entry that ultimately fails has its promise rejected — but if
  // nobody is concurrently awaiting it, that would otherwise surface as an
  // unhandled rejection. Swallow it here; the failing caller sees the real
  // error via its own try/catch, not via this promise.
  promise.catch(() => {})

  const entry: IdempotencyEntry = {
    status: 'pending',
    txHash: null,
    createdAt: Date.now(),
    promise,
    resolve: resolveFn,
    reject: rejectFn,
  }
  idempotencyMap.set(key, entry)
  return { kind: 'new', entry }
}

function settleIdempotencySuccess(key: string, entry: IdempotencyEntry, txHash: string): void {
  entry.status = 'committed'
  entry.txHash = txHash
  entry.createdAt = Date.now()
  entry.resolve(txHash)
  persistCommitted(key, txHash)
}

function settleIdempotencyFailure(key: string, entry: IdempotencyEntry, err: unknown): void {
  // Free the slot so a genuine retry (not a duplicate) can proceed.
  if (idempotencyMap.get(key) === entry) {
    idempotencyMap.delete(key)
  }
  entry.reject(err)
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
 * Normalizes a raw Stellar SDK TransactionResultCode `.name` (e.g. 'txBadSeq')
 * to the SCREAMING_SNAKE-ish key scheme used by mapResultCode's MAP (e.g.
 * 'txBAD_SEQ'). Falls back to the raw name for anything not explicitly
 * listed (mapResultCode already has a generic fallback for unknown keys).
 */
const OUTER_CODE_NORMALIZE: Record<string, string> = {
  txSuccess: 'txSUCCESS',
  txFailed: 'txFAILED',
  txTooEarly: 'txTOO_EARLY',
  txTooLate: 'txTOO_LATE',
  txMissingOperation: 'txMISSING_OPERATION',
  txBadSeq: 'txBAD_SEQ',
  txBadAuth: 'txBAD_AUTH',
  txInsufficientBalance: 'txINSUFFICIENT_BALANCE',
  txNoAccount: 'txNO_ACCOUNT',
  txInsufficientFee: 'txINSUFFICIENT_FEE',
  txBadAuthExtra: 'txBAD_AUTH_EXTRA',
  txInternalError: 'txINTERNAL_ERROR',
  txNotSupported: 'txNOT_SUPPORTED',
  txBadSponsorship: 'txBAD_SPONSORSHIP',
  txBadMinSeqAgeOrGap: 'txBAD_MIN_SEQ_AGE_OR_GAP',
  txMalformed: 'txMALFORMED',
  txSorobanInvalid: 'txSOROBAN_INVALID',
}

/** Normalizes a raw Stellar SDK PaymentResultCode `.name` to our MAP keys. */
const PAYMENT_RESULT_NORMALIZE: Record<string, string> = {
  paymentUnderfunded: 'opUNDERFUNDED',
  paymentNoDestination: 'opNO_DESTINATION',
  paymentLineFull: 'opLINE_FULL',
  paymentNoTrust: 'opNO_TRUST',
  paymentSrcNoTrust: 'opNO_TRUST',
  paymentMalformed: 'opMalformed',
  // paymentSrcNotAuthorized, paymentNotAuthorized, paymentNoIssuer, and
  // paymentSuccess (unreachable here — we're only called on failure) fall
  // through to the generic 'opINNER' bucket below.
}

/**
 * Resolves a single OperationResult from a failed transaction to one of our
 * normalized MAP keys. Distinguishes an operation that failed for a specific,
 * known reason (e.g. 'opNO_DESTINATION' — the escrow account doesn't exist)
 * from one that failed for a reason we don't have a dedicated message for
 * ('opINNER' — a generic "this operation failed" bucket).
 */
function normalizeOperationResultCode(opResult: xdr.OperationResult): string {
  const opCode = opResult.switch().name // 'opInner' | 'opBadAuth' | 'opNoAccount' | ...
  if (opCode !== 'opInner') {
    return opCode
  }

  const tr = opResult.tr()
  const trType = tr.switch().name // OperationType name, e.g. 'payment', 'invokeHostFunction'

  if (trType === 'payment') {
    const paymentCode = tr.paymentResult().switch().name
    return PAYMENT_RESULT_NORMALIZE[paymentCode] ?? 'opINNER'
  }

  // Soroban invocation trap (record_donation reverting) or any other
  // inner-operation type we don't have a more specific mapping for.
  return 'opINNER'
}

/**
 * Decode from a raw TransactionResult XDR (returned by getTransaction/
 * sendTransaction on failure). Accepts the resultXdr field directly.
 *
 * For a txFailed result this walks the actual operation-level results so a
 * payment failure (e.g. escrow missing → opNO_DESTINATION) is reported with
 * its specific reason instead of the operation's *type* name.
 */
export function decodeResultXdr(resultXdr: string): string {
  try {
    const result = xdr.TransactionResult.fromXDR(resultXdr, 'base64')
    const outerName = result.result().switch().name as string

    if (outerName !== 'txFailed') {
      return mapResultCode(OUTER_CODE_NORMALIZE[outerName] ?? outerName)
    }

    const opResults = result.result().results?.() ?? []
    for (const opResult of opResults) {
      const code = normalizeOperationResultCode(opResult)
      if (code && code !== 'opINNER') {
        return mapResultCode(code)
      }
    }

    // The transaction failed, and either it had no per-operation results or
    // none of them mapped to a specific known reason — report the generic
    // "something in this transaction failed" case rather than a blank message.
    return mapResultCode('opINNER')
  } catch {
    return 'Transaction failed — please check your wallet balance and try again'
  }
}

/** Returns the raw (un-normalized) outer TransactionResultCode name, or null if undecodable. */
function decodeOuterResultCodeRaw(resultXdr: string): string | null {
  try {
    const result = xdr.TransactionResult.fromXDR(resultXdr, 'base64')
    return result.result().switch().name as string
  } catch {
    return null
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
    opINNER:
      'A payment or contract call inside this transaction failed — please check your balance and try again',
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

const DEFAULT_POLL_INTERVAL_MS = 2_000
const MAX_POLL_ATTEMPTS = 30 // 60 seconds max

/**
 * Override the per-attempt poll delay in milliseconds.
 * For test use only — pass 0 to make polling instant. Matches the pattern
 * used by use-claim.ts's __setPollDelayMs.
 */
let _pollDelayOverrideMs: number | null = null
/** @internal test-only */
export function __setDonationPollDelayMs(ms: number | null): void {
  _pollDelayOverrideMs = ms
}

/**
 * Polls getTransaction until the transaction lands, fails, or the client-side
 * timeout elapses. On timeout, performs ONE additional getTransaction probe
 * before giving up — Soroban RPC retains results for ~10 ledgers (~50s)
 * after submission, so a transaction that lands just after our last regular
 * poll is still detected as a success (issue #139, Scenario A) instead of
 * being reported as a hard failure while the donor's funds already moved.
 */
export async function pollForResult(
  rpc: SorobanRpc.Server,
  hash: string,
): Promise<string> {
  const inspectResult = (result: SorobanRpc.Api.GetTransactionResponse): string | null => {
    if (result.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      return hash
    }
    if (result.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      const resultXdr = (result as SorobanRpc.Api.GetFailedTransactionResponse).resultXdr
      const msg = resultXdr ? decodeResultXdr(resultXdr.toXDR('base64')) : 'Transaction failed on-chain'
      throw new DonationError(msg)
    }
    return null // NOT_FOUND — still in flight
  }

  const pollIntervalMs = _pollDelayOverrideMs ?? DEFAULT_POLL_INTERVAL_MS

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, pollIntervalMs))
    const result = await rpc.getTransaction(hash)
    const outcome = inspectResult(result)
    if (outcome) return outcome
  }

  // Client-side polling window elapsed without a definitive answer — one
  // more probe before we treat this as a hard failure.
  const lateResult = await rpc.getTransaction(hash)
  const lateOutcome = inspectResult(lateResult)
  if (lateOutcome) return lateOutcome

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
// Sequence-number-collision retry
// ---------------------------------------------------------------------------

const MAX_SEQ_RETRY_ATTEMPTS = 3
const DEFAULT_SEQ_RETRY_BACKOFF_MS = 300

/**
 * Override the sequence-retry backoff in milliseconds.
 * For test use only — pass 0 to make retries instant.
 */
let _seqRetryBackoffOverrideMs: number | null = null
/** @internal test-only */
export function __setSeqRetryBackoffMs(ms: number | null): void {
  _seqRetryBackoffOverrideMs = ms
}

interface BuildDonationTxParams {
  account: Account
  networkPassphrase: string
  escrowAddress: string
  amountStr: string
  campaignId: string
  donorAddress: string
  stroops: bigint
  nonce: string
}

/** Builds the two-operation dual-write envelope (payment + record_donation). */
function buildDonationTx(params: BuildDonationTxParams) {
  return new TransactionBuilder(params.account, {
    fee: BASE_FEE,
    networkPassphrase: params.networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: params.escrowAddress,
        asset: Asset.native(),
        amount: params.amountStr,
      }),
    )
    .addOperation(
      Operation.invokeContractFunction({
        contract: CONTRACT_IDS.CAMPAIGN_MANAGER,
        function: 'record_donation',
        args: [
          nativeToScVal(params.campaignId, { type: 'symbol' }),
          nativeToScVal(params.donorAddress, { type: 'address' }),
          nativeToScVal(params.stroops, { type: 'i128' }),
          // Optional trailing idempotency nonce (issue #139). A
          // record_donation deployment that doesn't yet accept a 4th
          // argument would reject this call the same way it would reject
          // any other unexpected-arity invocation — this is only safe to
          // ship once the contract's signature adds this parameter with a
          // default, per the issue's ABI-compatibility constraint.
          nativeToScVal(params.nonce, { type: 'string' }),
        ],
      }),
    )
    .setTimeout(180) // 3-minute validity window
    .build()
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

  /**
   * Runs the full fee-estimation → confirm → sign → submit → poll flow for a
   * freshly-claimed idempotency entry, settling that entry on the way out.
   */
  const runDonationFlow = useCallback(
    async (
      entry: IdempotencyEntry,
      idempotencyKey: string,
      donorAddress: string,
      network: string,
      amountXLM: number,
    ) => {
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
        // Fetch source account for sequence number
        // ----------------------------------------------------------------
        const sourceAccount = await rpc.getAccount(donorAddress)

        // ----------------------------------------------------------------
        // Fetch campaign escrow address from contract
        //    Function: get_campaign_escrow(campaignId: symbol) -> address
        // ----------------------------------------------------------------
        let escrowAddress: string
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
            const { StrKey } = await import('@stellar/stellar-sdk')
            escrowAddress = StrKey.encodeEd25519PublicKey(addrXdr.accountId().ed25519())
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

        // ----------------------------------------------------------------
        // Re-fetch account (sequence may have changed during escrow call)
        // ----------------------------------------------------------------
        let account = await rpc.getAccount(donorAddress)

        // ----------------------------------------------------------------
        // Build the dual-write transaction envelope
        // ----------------------------------------------------------------
        const amountStr = amountXLM.toFixed(7) // Stellar requires 7 decimal places
        const stroops = xlmToStroops(amountXLM)
        const nonce = generateDonationNonce(idempotencyKey)

        let builtTx = buildDonationTx({
          account,
          networkPassphrase,
          escrowAddress,
          amountStr,
          campaignId,
          donorAddress,
          stroops,
          nonce,
        })

        // ----------------------------------------------------------------
        // Simulate to get fee estimate
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
        // Present fee to user — suspend until confirmed or dismissed
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
        // Sign + submit, with a silent retry-with-backoff on txBadSeq
        // (issue #139, Scenario D) — no user-visible error until retries
        // are exhausted.
        // ----------------------------------------------------------------
        let txHash: string | null = null
        let seqRetryAttempt = 0

        for (;;) {
          setState((s) => ({ ...s, status: 'signing' }))

          const preparedTx = SorobanRpc.assembleTransaction(builtTx, simResult).build()
          const preparedXdr = preparedTx.toEnvelope().toXDR('base64')

          let signResult: Awaited<ReturnType<typeof signTransaction>>
          try {
            signResult = await signTransaction(preparedXdr, {
              networkPassphrase,
              address: donorAddress,
            })
          } catch (signErr) {
            // Freighter throws directly when the user closes/declines the
            // popup or the extension is missing/locked — classify rather
            // than leak.
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

          setState((s) => ({ ...s, status: 'submitting' }))

          const { TransactionBuilder: TB } = await import('@stellar/stellar-sdk')
          const signedTx = TB.fromXDR(signedXdr, networkPassphrase)

          const sendResult = await rpc.sendTransaction(signedTx)

          if (sendResult.status !== 'ERROR') {
            txHash = sendResult.hash
            break
          }

          const errXdr = sendResult.errorResult?.toXDR('base64')
          const outerCode = errXdr ? decodeOuterResultCodeRaw(errXdr) : null

          if (outerCode === 'txBadSeq' && seqRetryAttempt < MAX_SEQ_RETRY_ATTEMPTS) {
            seqRetryAttempt++
            const backoffMs = _seqRetryBackoffOverrideMs ?? DEFAULT_SEQ_RETRY_BACKOFF_MS
            await new Promise((r) => setTimeout(r, backoffMs * seqRetryAttempt))
            // Sequence-only failure: re-fetch the account and rebuild the
            // envelope with the same operations/fee. No need to re-simulate
            // — resource fees are independent of the sequence number — so
            // this retry stays off the network round-trip the fix must
            // avoid on the hot path.
            account = await rpc.getAccount(donorAddress)
            builtTx = buildDonationTx({
              account,
              networkPassphrase,
              escrowAddress,
              amountStr,
              campaignId,
              donorAddress,
              stroops,
              nonce,
            })
            continue
          }

          const msg = errXdr ? decodeResultXdr(errXdr) : 'Transaction rejected by the network'
          throw new DonationError(msg)
        }

        if (!txHash) {
          throw new DonationError('Transaction submission did not return a hash — please try again')
        }

        // ----------------------------------------------------------------
        // Poll for confirmation
        // ----------------------------------------------------------------
        setState((s) => ({ ...s, status: 'polling', txHash }))

        await pollForResult(rpc, txHash)

        // ----------------------------------------------------------------
        // Success
        // ----------------------------------------------------------------
        settleIdempotencySuccess(idempotencyKey, entry, txHash)

        setState({
          status: 'success',
          estimatedFee: totalFeeXlm,
          txHash,
          error: null,
          isDuplicate: false,
        })
      } catch (err: unknown) {
        // Fee dismissed is an expected cancellation — return to idle. This
        // is a user choice, not a failed donation, so the idempotency slot
        // is freed without recording a failure reason.
        if (err === 'FEE_DISMISSED') {
          settleIdempotencyFailure(idempotencyKey, entry, err)
          setState(initialState())
          return
        }

        // Safety net for Scenario B (double-submit race across separate
        // tabs/sessions that don't share the in-memory map): if this
        // attempt failed but another attempt for the exact same key
        // committed successfully in the meantime, treat it as a duplicate
        // rather than surfacing an error over funds that already moved.
        const concurrentlyCommitted = idempotencyMap.get(idempotencyKey)
        if (concurrentlyCommitted && concurrentlyCommitted !== entry && concurrentlyCommitted.status === 'committed') {
          settleIdempotencyFailure(idempotencyKey, entry, err)
          setState({
            status: 'success',
            estimatedFee: null,
            txHash: concurrentlyCommitted.txHash,
            error: null,
            isDuplicate: true,
          })
          return
        }

        settleIdempotencyFailure(idempotencyKey, entry, err)

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
    [campaignId],
  )

  const donate = useCallback(
    async (amountXLM: number) => {
      // ------------------------------------------------------------------
      // Guard: wallet connected
      // ------------------------------------------------------------------
      if (!wallet.isConnected || !wallet.publicKey) {
        throw new WalletNotConnectedError()
      }

      // ------------------------------------------------------------------
      // Guard: minimum amount (1 stroop = 0.0000001 XLM)
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
      // Optimistic idempotency claim — this is the FIRST thing donate()
      // does, before any network I/O, so a concurrent call for the same
      // key (Scenario B) attaches to this attempt instead of racing it.
      // ------------------------------------------------------------------
      const idempotencyKey = buildIdempotencyKey(donorAddress, campaignId, amountXLM)
      const claim = claimIdempotencySlot(idempotencyKey)

      if (claim.kind === 'duplicate') {
        try {
          const txHash = await claim.promise
          setState({
            status: 'success',
            estimatedFee: null,
            txHash,
            error: null,
            isDuplicate: true,
          })
        } catch {
          // The in-flight/prior attempt for this key failed — its slot has
          // already been freed by settleIdempotencyFailure, so this caller
          // gets its own fresh attempt instead of surfacing a stale error.
          const retryClaim = claimIdempotencySlot(idempotencyKey)
          if (retryClaim.kind === 'new') {
            await runDonationFlow(retryClaim.entry, idempotencyKey, donorAddress, network, amountXLM)
          } else {
            try {
              const txHash = await retryClaim.promise
              setState({
                status: 'success',
                estimatedFee: null,
                txHash,
                error: null,
                isDuplicate: true,
              })
            } catch (err) {
              console.error('[useDonation] donation failed:', err)
              setState((s) => ({ ...s, status: 'error', error: classifyDonationError(err) }))
            }
          }
        }
        return
      }

      await runDonationFlow(claim.entry, idempotencyKey, donorAddress, network, amountXLM)
    },
    [campaignId, wallet, runDonationFlow],
  )

  return { state, donate, reset, feeConfirmed, feeDismissed }
}
