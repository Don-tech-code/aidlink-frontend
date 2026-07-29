/**
 * allocations.ts
 *
 * Fetches the current beneficiary allocations from the BENEFICIARY_REGISTRY
 * Soroban contract.
 *
 * Contract function: `get_allocations(beneficiary: Address) → Vec<AllocationEntry>`
 *
 * Each returned entry is decoded from the contract's ScVal map into the
 * strongly-typed `Allocation` interface defined in @/types.
 *
 * Design notes
 * ────────────
 * • This is a read-only simulation (no wallet signing required).  We build a
 *   transaction, call simulateTransaction, and extract the return value from
 *   the simulation result.  No fee is charged and no network state is mutated.
 * • All ScVal decoding is done inline; values that cannot be decoded are
 *   given safe defaults so a single malformed entry doesn't crash the whole
 *   list.
 */

import {
  BASE_FEE,
  Operation,
  SorobanRpc,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'
import { CONTRACT_IDS, SOROBAN_NETWORKS } from '@/config/constants'
import type { Allocation } from '@/types'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AllocationsContractNotConfiguredError extends Error {
  readonly code = 'CONTRACT_NOT_CONFIGURED' as const
  constructor() {
    super(
      'The Beneficiary Registry contract is not configured. ' +
        'Set NEXT_PUBLIC_BENEFICIARY_REGISTRY_CONTRACT in your environment.',
    )
    this.name = 'AllocationsContractNotConfiguredError'
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
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

/** Safely extract a string from ScvString or ScvSymbol; returns fallback on error. */
function scvString(val: xdr.ScVal, fallback = ''): string {
  try {
    if (val.switch().name === 'scvString') return val.str().toString()
    if (val.switch().name === 'scvSymbol') return val.sym().toString()
  } catch {
    // swallow
  }
  return fallback
}

/** Safely extract a u64/u128/i64 as bigint; returns 0n on error. */
function scvUint(val: xdr.ScVal): bigint {
  try {
    switch (val.switch().name) {
      case 'scvU64':
        return val.u64().toBigInt()
      case 'scvI64':
        return val.i64().toBigInt()
      case 'scvU128': {
        const parts = val.u128()
        // hi (u64) × 2^64 + lo (u64)
        return (parts.hi().toBigInt() << BigInt(64)) | parts.lo().toBigInt()
      }
      case 'scvU32':
        return BigInt(val.u32())
      case 'scvI32':
        return BigInt(val.i32())
    }
  } catch {
    // swallow
  }
  return BigInt(0)
}

/** Safely extract a boolean from ScvBool; returns fallback on error. */
function scvBool(val: xdr.ScVal, fallback = false): boolean {
  try {
    if (val.switch().name === 'scvBool') return val.b()
  } catch {
    // swallow
  }
  return fallback
}

/** Safely extract an epoch-seconds u64 / i64 / u32 and format as ISO string. */
function scvTimestamp(val: xdr.ScVal): string {
  try {
    const secs = scvUint(val)
    if (secs > 0n) return new Date(Number(secs) * 1000).toISOString()
  } catch {
    // swallow
  }
  return new Date().toISOString()
}

// (address decoding not needed for the allocations list path)

/**
 * Decode a single ScVal map entry into an Allocation.
 *
 * The contract is expected to return each entry as an scvMap with keys:
 *   claim_id, campaign_id, campaign_name, allocated_amount, is_claimed,
 *   created_at, expires_at (optional)
 *
 * Key names are matched case-insensitively and with both snake_case and
 * camelCase variations to be robust against minor contract API differences.
 */
function decodeAllocationEntry(entry: xdr.ScVal): Allocation | null {
  try {
    if (entry.switch().name !== 'scvMap') return null
    const map = entry.map() ?? []

    const get = (key: string): xdr.ScVal | undefined => {
      const lower = key.toLowerCase()
      return map.find((kv) => {
        const k = scvString(kv.key()).toLowerCase().replace(/-/g, '_')
        return k === lower
      })?.val()
    }

    const claimId =
      scvString(get('claim_id') ?? xdr.ScVal.scvVoid()) ||
      scvString(get('claimid') ?? xdr.ScVal.scvVoid()) ||
      scvString(get('id') ?? xdr.ScVal.scvVoid())

    const campaignId =
      scvString(get('campaign_id') ?? xdr.ScVal.scvVoid()) ||
      scvString(get('campaignid') ?? xdr.ScVal.scvVoid())

    const campaignName =
      scvString(get('campaign_name') ?? xdr.ScVal.scvVoid()) ||
      scvString(get('campaignname') ?? xdr.ScVal.scvVoid()) ||
      scvString(get('name') ?? xdr.ScVal.scvVoid()) ||
      campaignId

    const rawAmount = get('allocated_amount') ?? get('allocatedamount') ?? get('amount')
    const allocatedAmountStroops = rawAmount ? scvUint(rawAmount) : BigInt(0)

    const rawClaimed = get('is_claimed') ?? get('isclaimed') ?? get('claimed')
    const isClaimed = rawClaimed ? scvBool(rawClaimed) : false

    const rawCreatedAt = get('created_at') ?? get('createdat')
    const createdAt = rawCreatedAt
      ? scvTimestamp(rawCreatedAt)
      : new Date().toISOString()

    const rawExpiresAt = get('expires_at') ?? get('expiresat')
    const expiresAt = rawExpiresAt
      ? scvTimestamp(rawExpiresAt)
      : undefined

    if (!claimId) return null // cannot identify the entry without a claim ID

    return {
      claimId,
      campaignId,
      campaignName,
      allocatedAmountStroops,
      isClaimed,
      createdAt,
      expiresAt,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch all allocations for a beneficiary from the BENEFICIARY_REGISTRY contract.
 *
 * This is a read-only call: we simulate the transaction and extract the
 * return value without submitting anything to the network.
 *
 * @param beneficiaryAddress  Stellar public key of the beneficiary.
 * @param network             Network name ('testnet' | 'mainnet' | …).
 * @returns                   Array of decoded Allocation objects.
 *
 * @throws AllocationsContractNotConfiguredError  when the contract ID env var is empty.
 * @throws Error  when the simulation fails or the contract returns an error.
 */
export async function getContractAllocations(
  beneficiaryAddress: string,
  network: string,
): Promise<Allocation[]> {
  const contractId = CONTRACT_IDS.BENEFICIARY_REGISTRY
  if (!contractId) throw new AllocationsContractNotConfiguredError()

  const rpc = getRpcServer(network)
  const networkPassphrase = getNetworkPassphrase(network)

  // Use the beneficiary's own account as the simulated source (read-only;
  // no actual fee is charged).
  const sourceAccount = await rpc.getAccount(beneficiaryAddress)

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contractId,
        function: 'get_allocations',
        args: [nativeToScVal(beneficiaryAddress, { type: 'address' })],
      }),
    )
    .setTimeout(30)
    .build()

  const simResult = await rpc.simulateTransaction(tx)

  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new Error(`get_allocations failed: ${simResult.error}`)
  }

  const successResult =
    simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse
  const retval = successResult.result?.retval

  // If the contract returns void or an empty result, treat as empty list
  if (!retval || retval.switch().name === 'scvVoid') return []

  // Expected: Vec<AllocationEntry>
  if (retval.switch().name !== 'scvVec') {
    // Possibly a single entry returned directly (non-vector)
    const single = decodeAllocationEntry(retval)
    return single ? [single] : []
  }

  const vec = retval.vec() ?? []
  const allocations: Allocation[] = []

  for (const entry of vec) {
    const decoded = decodeAllocationEntry(entry)
    if (decoded) allocations.push(decoded)
    // Skip null entries silently — a malformed entry shouldn't crash the portal
  }

  return allocations
}

/**
 * Simulate the `claim` function to get an estimated fee and verify eligibility.
 *
 * This DOES NOT submit a transaction — it only calls simulateTransaction to:
 *  1. Confirm the claimant is eligible (contract will throw if not)
 *  2. Return the minResourceFee for display to the user
 *
 * @param claimId             The allocation claim ID.
 * @param beneficiaryAddress  Stellar public key of the claimant.
 * @param network             Network name.
 * @returns                   Estimated fee in stroops (as bigint).
 *
 * @throws Error with a decoded message if the contract rejects the simulation.
 */
export async function simulateClaim(
  claimId: string,
  beneficiaryAddress: string,
  network: string,
): Promise<{ feeStroops: bigint; preparedTxXdr: string }> {
  const contractId = CONTRACT_IDS.BENEFICIARY_REGISTRY
  if (!contractId) throw new AllocationsContractNotConfiguredError()

  const rpc = getRpcServer(network)
  const networkPassphrase = getNetworkPassphrase(network)

  const sourceAccount = await rpc.getAccount(beneficiaryAddress)

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contractId,
        function: 'claim',
        args: [
          nativeToScVal(claimId, { type: 'string' }),
          nativeToScVal(beneficiaryAddress, { type: 'address' }),
        ],
      }),
    )
    .setTimeout(180)
    .build()

  const simResult = await rpc.simulateTransaction(tx)

  if (SorobanRpc.Api.isSimulationError(simResult)) {
    const errMsg = simResult.error ?? ''

    // Detect already-claimed contract error variants
    const lower = errMsg.toLowerCase()
    if (
      lower.includes('already_claimed') ||
      lower.includes('already claimed') ||
      lower.includes('alreadyclaimed') ||
      lower.includes('double') ||
      lower.includes('duplicate')
    ) {
      throw new AlreadyClaimedError(claimId)
    }

    // Detect verification-not-complete errors
    if (
      lower.includes('not_verified') ||
      lower.includes('unverified') ||
      lower.includes('verification required') ||
      lower.includes('not verified')
    ) {
      throw new VerificationRequiredError()
    }

    throw new Error(`Claim simulation failed: ${simResult.error}`)
  }

  const successResult =
    simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse

  // minResourceFee is the additional Soroban resource fee in stroops
  const minResourceFeeStroops = BigInt(successResult.minResourceFee ?? '0')
  // BASE_FEE (100 stroops) + resource fee = total estimated fee
  const feeStroops = BigInt(BASE_FEE) + minResourceFeeStroops

  // Assemble the transaction with the correct resource footprint for signing
  const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build()
  const preparedTxXdr = preparedTx.toEnvelope().toXDR('base64')

  return { feeStroops, preparedTxXdr }
}

// ---------------------------------------------------------------------------
// Domain errors thrown by simulateClaim
// ---------------------------------------------------------------------------

export class AlreadyClaimedError extends Error {
  readonly code = 'ALREADY_CLAIMED' as const
  constructor(claimId: string) {
    super(`This allocation was already claimed. (claimId: ${claimId})`)
    this.name = 'AlreadyClaimedError'
  }
}

export class VerificationRequiredError extends Error {
  readonly code = 'VERIFICATION_REQUIRED' as const
  constructor() {
    super(
      'Your identity must be verified before you can claim aid. ' +
        'Complete the verification process and wait for approval.',
    )
    this.name = 'VerificationRequiredError'
  }
}
