/**
 * Contract invocation helpers for the BENEFICIARY_REGISTRY Soroban contract.
 *
 * All functions return typed results and throw descriptive errors that are safe
 * to display directly in the UI.
 *
 * Soroban interactions follow the same pattern as use-donation.ts:
 *   simulate → assemble → sign (Freighter) → sendTransaction → poll
 *
 * Functions that only READ state (get_beneficiary_status, list_pending_verifications,
 * get_admins) use simulateTransaction only — no wallet signing required.
 */

import {
  BASE_FEE,
  Operation,
  SorobanRpc,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'
import { signTransaction } from '@stellar/freighter-api'
import { CONTRACT_IDS, SOROBAN_NETWORKS } from '@/config/constants'
import type { VerificationStatus } from '@/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PendingVerificationEntry {
  address: string
  proofCid: string
  submittedAt: string
  /** Raw on-chain display name if the contract stores it; otherwise undefined */
  name?: string
}

export interface PendingVerificationsPage {
  entries: PendingVerificationEntry[]
  nextCursor: string | null
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ContractNotConfiguredError extends Error {
  readonly code = 'CONTRACT_NOT_CONFIGURED' as const
  constructor() {
    super(
      'The Beneficiary Registry contract is not configured. ' +
        'Set NEXT_PUBLIC_BENEFICIARY_REGISTRY_CONTRACT in your environment.',
    )
    this.name = 'ContractNotConfiguredError'
  }
}

export class NotAnAdminError extends Error {
  readonly code = 'NOT_AN_ADMIN' as const
  constructor(address: string) {
    super(
      `The connected wallet (${address}) is not registered as an admin in the contract.`,
    )
    this.name = 'NotAnAdminError'
  }
}

// ---------------------------------------------------------------------------
// RPC / network helpers  (mirrors use-donation.ts)
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

/** Assert the contract ID is set; throw ContractNotConfiguredError otherwise. */
function assertContractConfigured(): string {
  const id = CONTRACT_IDS.BENEFICIARY_REGISTRY
  if (!id) throw new ContractNotConfiguredError()
  return id
}

// ---------------------------------------------------------------------------
// ScVal decoding helpers
// ---------------------------------------------------------------------------

/**
 * Map the on-chain ScvSymbol value to our VerificationStatus type.
 *
 * Expected symbol values from the contract:
 *   "Unverified" | "Pending" | "Verified" | "Rejected"
 */
export function scvSymbolToVerificationStatus(
  val: xdr.ScVal,
): VerificationStatus {
  if (val.switch().name !== 'scvSymbol') {
    throw new Error(`Expected ScvSymbol, got ${val.switch().name}`)
  }
  const sym = val.sym().toString()
  switch (sym) {
    case 'Unverified':
      return 'unverified'
    case 'Pending':
      return 'pending'
    case 'Verified':
      return 'verified'
    case 'Rejected':
      return 'rejected'
    default:
      throw new Error(`Unknown verification status symbol: ${sym}`)
  }
}

/** Extract a string from an ScvString ScVal. */
function extractString(val: xdr.ScVal): string {
  if (val.switch().name === 'scvString') {
    return val.str().toString()
  }
  if (val.switch().name === 'scvSymbol') {
    return val.sym().toString()
  }
  throw new Error(`Expected ScvString or ScvSymbol, got ${val.switch().name}`)
}

/** Extract a u64/i64 epoch-seconds value and convert to ISO string. */
function extractTimestamp(val: xdr.ScVal): string {
  let epochSec: bigint
  switch (val.switch().name) {
    case 'scvU64':
      epochSec = val.u64().toBigInt()
      break
    case 'scvI64':
      epochSec = val.i64().toBigInt()
      break
    case 'scvU32':
      epochSec = BigInt(val.u32())
      break
    default:
      throw new Error(`Cannot extract timestamp from ${val.switch().name}`)
  }
  return new Date(Number(epochSec) * 1000).toISOString()
}

/** Extract a Stellar StrKey address from an scvAddress ScVal. */
async function extractAddress(val: xdr.ScVal): Promise<string> {
  if (val.switch().name !== 'scvAddress') {
    throw new Error(`Expected scvAddress, got ${val.switch().name}`)
  }
  const addrXdr = val.address()
  if (addrXdr.switch().name === 'scAddressTypeAccount') {
    const { StrKey } = await import('@stellar/stellar-sdk')
    return StrKey.encodeEd25519PublicKey(addrXdr.accountId().ed25519())
  }
  // Contract address — return hex representation
  return addrXdr.contractId().toString('hex')
}

// ---------------------------------------------------------------------------
// Polling helper  (exponential backoff per the spec)
// ---------------------------------------------------------------------------

const MAX_BACKOFF_MS = 16_000

/**
 * Poll for a submitted transaction with exponential backoff.
 *
 * Delays: 1s → 2s → 4s → 8s → 16s (max), up to maxRetries attempts.
 */
export async function pollWithBackoff(
  rpc: SorobanRpc.Server,
  hash: string,
  maxRetries = 5,
): Promise<void> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const delay = Math.min(1000 * Math.pow(2, attempt), MAX_BACKOFF_MS)
    await new Promise((r) => setTimeout(r, delay))

    const result = await rpc.getTransaction(hash)

    if (result.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      return
    }

    if (result.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      const failedResult = result as SorobanRpc.Api.GetFailedTransactionResponse
      const xdrStr = failedResult.resultXdr?.toXDR('base64') ?? ''
      throw new Error(`Transaction failed on-chain${xdrStr ? ` (${xdrStr})` : ''}`)
    }
    // NOT_FOUND → still in flight, keep polling
  }
  throw new Error(
    'Transaction timed out — it may still confirm. Check your wallet history.',
  )
}

// ---------------------------------------------------------------------------
// Read-only contract calls (simulate only, no signing)
// ---------------------------------------------------------------------------

/**
 * Fetch the current on-chain verification status for a beneficiary address.
 *
 * Contract function: `get_beneficiary_status(beneficiary: Address) → Symbol`
 */
export async function getBeneficiaryStatus(
  beneficiaryAddress: string,
  network: string,
): Promise<{ status: VerificationStatus; rejectionReason?: string }> {
  const contractId = assertContractConfigured()
  const rpc = getRpcServer(network)
  const networkPassphrase = getNetworkPassphrase(network)

  // Use a dummy source account for simulation (any valid-format address works)
  const sourceAccount = await rpc.getAccount(beneficiaryAddress)

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contractId,
        function: 'get_beneficiary_status',
        args: [nativeToScVal(beneficiaryAddress, { type: 'address' })],
      }),
    )
    .setTimeout(30)
    .build()

  const simResult = await rpc.simulateTransaction(tx)

  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new Error(`get_beneficiary_status failed: ${simResult.error}`)
  }

  const retval = (simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse)
    .result?.retval

  if (!retval) {
    throw new Error('Contract returned no value for get_beneficiary_status')
  }

  // The contract may return a Map with { status: Symbol, reason?: String }
  // or just a Symbol for the status.
  if (retval.switch().name === 'scvMap') {
    const map = retval.map() ?? []
    let status: VerificationStatus = 'unverified'
    let rejectionReason: string | undefined

    for (const entry of map) {
      const key = entry.key().switch().name === 'scvSymbol'
        ? entry.key().sym().toString()
        : entry.key().str().toString()

      if (key === 'status') {
        status = scvSymbolToVerificationStatus(entry.val())
      } else if (key === 'reason') {
        try {
          rejectionReason = extractString(entry.val())
        } catch {
          // no reason stored
        }
      }
    }

    return { status, rejectionReason }
  }

  // Simple Symbol return
  return { status: scvSymbolToVerificationStatus(retval) }
}

/**
 * Fetch the list of admin addresses from the contract.
 *
 * Contract function: `get_admins() → Vec<Address>`
 */
export async function getAdmins(network: string): Promise<string[]> {
  const contractId = assertContractConfigured()
  const rpc = getRpcServer(network)
  const networkPassphrase = getNetworkPassphrase(network)

  // get_admins needs no source account beyond a valid Stellar address;
  // we use a synthetic zero-balance account stub via the RPC ledger endpoint.
  // In practice we simulate against the contract directly.
  // Soroban simulation does not debit fees, so any valid-format source key works.
  // We'll use the zero address pattern:
  const ZERO_ACCOUNT = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN'

  let sourceAccount: SorobanRpc.Api.Account
  try {
    sourceAccount = await rpc.getAccount(ZERO_ACCOUNT)
  } catch {
    // If that account doesn't exist on this network, use a fake sequence
    const { Account } = await import('@stellar/stellar-sdk')
    sourceAccount = new Account(ZERO_ACCOUNT, '0') as unknown as SorobanRpc.Api.Account
  }

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contractId,
        function: 'get_admins',
        args: [],
      }),
    )
    .setTimeout(30)
    .build()

  const simResult = await rpc.simulateTransaction(tx)

  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new Error(`get_admins failed: ${simResult.error}`)
  }

  const retval = (simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse)
    .result?.retval

  if (!retval || retval.switch().name !== 'scvVec') {
    return []
  }

  const entries = retval.vec() ?? []
  const addresses: string[] = []
  for (const entry of entries) {
    try {
      addresses.push(await extractAddress(entry))
    } catch {
      // skip malformed entries
    }
  }
  return addresses
}

/**
 * Fetch a page of pending verification entries.
 *
 * Contract function: `list_pending_verifications(cursor: Option<String>, limit: u32) → { entries: Vec<…>, next_cursor: Option<String> }`
 */
export async function listPendingVerifications(
  network: string,
  cursor: string | null,
  limit = 20,
): Promise<PendingVerificationsPage> {
  const contractId = assertContractConfigured()
  const rpc = getRpcServer(network)
  const networkPassphrase = getNetworkPassphrase(network)

  const ZERO_ACCOUNT = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN'
  let sourceAccount: SorobanRpc.Api.Account
  try {
    sourceAccount = await rpc.getAccount(ZERO_ACCOUNT)
  } catch {
    const { Account } = await import('@stellar/stellar-sdk')
    sourceAccount = new Account(ZERO_ACCOUNT, '0') as unknown as SorobanRpc.Api.Account
  }

  const cursorArg = cursor
    ? nativeToScVal(cursor, { type: 'string' })
    : xdr.ScVal.scvVoid()

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contractId,
        function: 'list_pending_verifications',
        args: [cursorArg, nativeToScVal(limit, { type: 'u32' })],
      }),
    )
    .setTimeout(30)
    .build()

  const simResult = await rpc.simulateTransaction(tx)

  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new Error(`list_pending_verifications failed: ${simResult.error}`)
  }

  const retval = (simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse)
    .result?.retval

  if (!retval || retval.switch().name !== 'scvMap') {
    return { entries: [], nextCursor: null }
  }

  const topMap = retval.map() ?? []
  let entries: PendingVerificationEntry[] = []
  let nextCursor: string | null = null

  for (const field of topMap) {
    const key = field.key().switch().name === 'scvSymbol'
      ? field.key().sym().toString()
      : field.key().str().toString()

    if (key === 'entries' && field.val().switch().name === 'scvVec') {
      const vec = field.val().vec() ?? []
      entries = await Promise.all(
        vec.map(async (item) => {
          const itemMap = item.map() ?? []
          const entry: Partial<PendingVerificationEntry> = {}
          for (const kv of itemMap) {
            const k = kv.key().switch().name === 'scvSymbol'
              ? kv.key().sym().toString()
              : kv.key().str().toString()
            if (k === 'address') {
              entry.address = await extractAddress(kv.val())
            } else if (k === 'proof_cid') {
              entry.proofCid = extractString(kv.val())
            } else if (k === 'submitted_at') {
              try {
                entry.submittedAt = extractTimestamp(kv.val())
              } catch {
                entry.submittedAt = new Date().toISOString()
              }
            } else if (k === 'name') {
              try {
                entry.name = extractString(kv.val())
              } catch {
                // optional
              }
            }
          }
          return {
            address: entry.address ?? '',
            proofCid: entry.proofCid ?? '',
            submittedAt: entry.submittedAt ?? new Date().toISOString(),
            name: entry.name,
          }
        }),
      )
    } else if (key === 'next_cursor') {
      const v = field.val()
      if (v.switch().name !== 'scvVoid') {
        try {
          nextCursor = extractString(v)
        } catch {
          nextCursor = null
        }
      }
    }
  }

  return { entries, nextCursor }
}

// ---------------------------------------------------------------------------
// Write contract calls (sign + submit)
// ---------------------------------------------------------------------------

interface WriteCallOptions {
  network: string
  signerAddress: string
}

/**
 * Submit a beneficiary proof to the contract.
 *
 * Contract function: `submit_proof(beneficiary: Address, proof_cid: String)`
 *
 * @returns Transaction hash on success.
 */
export async function submitProof(
  beneficiaryAddress: string,
  proofCid: string,
  { network, signerAddress }: WriteCallOptions,
): Promise<string> {
  const contractId = assertContractConfigured()
  const rpc = getRpcServer(network)
  const networkPassphrase = getNetworkPassphrase(network)

  const sourceAccount = await rpc.getAccount(signerAddress)

  const builtTx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contractId,
        function: 'submit_proof',
        args: [
          nativeToScVal(beneficiaryAddress, { type: 'address' }),
          nativeToScVal(proofCid, { type: 'string' }),
        ],
      }),
    )
    .setTimeout(180)
    .build()

  const simResult = await rpc.simulateTransaction(builtTx)
  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new Error(`submit_proof simulation failed: ${simResult.error}`)
  }

  const preparedTx = SorobanRpc.assembleTransaction(builtTx, simResult).build()
  const preparedXdr = preparedTx.toEnvelope().toXDR('base64')

  const signResult = await signTransaction(preparedXdr, {
    networkPassphrase,
    address: signerAddress,
  })
  const signedXdr =
    typeof signResult === 'string' ? signResult : signResult.signedTxXdr

  const { TransactionBuilder: TB } = await import('@stellar/stellar-sdk')
  const signedTx = TB.fromXDR(signedXdr, networkPassphrase)
  const sendResult = await rpc.sendTransaction(signedTx)

  if (sendResult.status === 'ERROR') {
    const errXdr = sendResult.errorResult?.toXDR('base64')
    throw new Error(
      errXdr
        ? `Transaction rejected by network (${errXdr})`
        : 'Transaction rejected by network',
    )
  }

  const txHash = sendResult.hash
  await pollWithBackoff(rpc, txHash)
  return txHash
}

/**
 * Verify a beneficiary (admin action).
 *
 * Contract function: `verify_beneficiary(beneficiary: Address, verifier: Address)`
 *
 * @returns Transaction hash on success.
 */
export async function verifyBeneficiary(
  beneficiaryAddress: string,
  { network, signerAddress }: WriteCallOptions,
): Promise<string> {
  const contractId = assertContractConfigured()
  const rpc = getRpcServer(network)
  const networkPassphrase = getNetworkPassphrase(network)

  const sourceAccount = await rpc.getAccount(signerAddress)

  const builtTx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contractId,
        function: 'verify_beneficiary',
        args: [
          nativeToScVal(beneficiaryAddress, { type: 'address' }),
          nativeToScVal(signerAddress, { type: 'address' }),
        ],
      }),
    )
    .setTimeout(180)
    .build()

  const simResult = await rpc.simulateTransaction(builtTx)
  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new Error(`verify_beneficiary simulation failed: ${simResult.error}`)
  }

  const preparedTx = SorobanRpc.assembleTransaction(builtTx, simResult).build()
  const preparedXdr = preparedTx.toEnvelope().toXDR('base64')

  const signResult = await signTransaction(preparedXdr, {
    networkPassphrase,
    address: signerAddress,
  })
  const signedXdr =
    typeof signResult === 'string' ? signResult : signResult.signedTxXdr

  const { TransactionBuilder: TB } = await import('@stellar/stellar-sdk')
  const signedTx = TB.fromXDR(signedXdr, networkPassphrase)
  const sendResult = await rpc.sendTransaction(signedTx)

  if (sendResult.status === 'ERROR') {
    const errXdr = sendResult.errorResult?.toXDR('base64')
    throw new Error(
      errXdr ? `Transaction rejected (${errXdr})` : 'Transaction rejected by network',
    )
  }

  const txHash = sendResult.hash
  await pollWithBackoff(rpc, txHash)
  return txHash
}

/**
 * Reject a beneficiary with a reason string (admin action).
 *
 * Contract function: `reject_beneficiary(beneficiary: Address, reason: String)`
 *
 * @returns Transaction hash on success.
 */
export async function rejectBeneficiary(
  beneficiaryAddress: string,
  reason: string,
  { network, signerAddress }: WriteCallOptions,
): Promise<string> {
  const contractId = assertContractConfigured()
  const rpc = getRpcServer(network)
  const networkPassphrase = getNetworkPassphrase(network)

  const sourceAccount = await rpc.getAccount(signerAddress)

  const builtTx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contractId,
        function: 'reject_beneficiary',
        args: [
          nativeToScVal(beneficiaryAddress, { type: 'address' }),
          nativeToScVal(reason, { type: 'string' }),
        ],
      }),
    )
    .setTimeout(180)
    .build()

  const simResult = await rpc.simulateTransaction(builtTx)
  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new Error(`reject_beneficiary simulation failed: ${simResult.error}`)
  }

  const preparedTx = SorobanRpc.assembleTransaction(builtTx, simResult).build()
  const preparedXdr = preparedTx.toEnvelope().toXDR('base64')

  const signResult = await signTransaction(preparedXdr, {
    networkPassphrase,
    address: signerAddress,
  })
  const signedXdr =
    typeof signResult === 'string' ? signResult : signResult.signedTxXdr

  const { TransactionBuilder: TB } = await import('@stellar/stellar-sdk')
  const signedTx = TB.fromXDR(signedXdr, networkPassphrase)
  const sendResult = await rpc.sendTransaction(signedTx)

  if (sendResult.status === 'ERROR') {
    const errXdr = sendResult.errorResult?.toXDR('base64')
    throw new Error(
      errXdr ? `Transaction rejected (${errXdr})` : 'Transaction rejected by network',
    )
  }

  const txHash = sendResult.hash
  await pollWithBackoff(rpc, txHash)
  return txHash
}
