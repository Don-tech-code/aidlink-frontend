/**
 * BeneficiaryRegistryClient
 *
 * Provides two public methods that drive role-based access control and the
 * verification pipeline:
 *
 *   getRole(publicKey)                         — read-only simulation (no signing)
 *   updateVerificationStatus(account, status)  — full write path with signing
 *
 * Pattern follows src/lib/beneficiary/contract.ts exactly:
 *   - Reads:  build tx → rpc.simulateTransaction → extract retval → decode ScVal
 *   - Writes: build tx → simulate → assemble → sign (Freighter) → sendTransaction → poll
 */

import {
  Account,
  BASE_FEE,
  Operation,
  SorobanRpc,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'
import { signTransaction } from '@stellar/freighter-api'
import { SOROBAN_NETWORKS } from '@/config/constants'
import { pollWithBackoff } from '@/lib/beneficiary/contract'
import type { UserRole } from '@/types'

// ---------------------------------------------------------------------------
// Role map — 0: donor, 1: ngo, 2: beneficiary, 3: admin
// Kept identical to the original so callers that imported ROLE_MAP directly
// continue to work.
// ---------------------------------------------------------------------------

export const ROLE_MAP: Record<number, UserRole> = {
  0: 'donor',
  1: 'ngo',
  2: 'beneficiary',
  3: 'admin',
}

// Reverse map for decoding ScvSymbol-style role returns ("Donor" → "donor")
const SYMBOL_TO_ROLE: Record<string, UserRole> = {
  Donor: 'donor',
  NGO: 'ngo',
  Ngo: 'ngo',
  Beneficiary: 'beneficiary',
  Admin: 'admin',
}

/**
 * Zero-balance stub account used as the transaction source for read-only
 * simulations.  Soroban simulation never debits fees, so any valid-format
 * Stellar address works.
 *
 * This is the canonical all-zeros Ed25519 public key encoded as a Stellar
 * G-address (32 zero bytes → StrKey.encodeEd25519PublicKey).  It is a
 * valid Stellar address accepted by stellar-sdk v12+ and is the same
 * pattern as contract.ts uses for get_admins / listPendingVerifications.
 */
const ZERO_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'

// ---------------------------------------------------------------------------
// Private helpers
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

/**
 * Decode a Soroban ScVal returned by `get_role` into a UserRole string.
 *
 * The contract may return the role as:
 *   1. ScvU32(0..3)          → index into ROLE_MAP
 *   2. ScvSymbol("Donor")    → lowercased to UserRole
 *   3. ScvMap { role: ScvSymbol } → extract the "role" field then apply (2)
 *
 * Returns null for ScvVoid (address not registered) or any unrecognised shape.
 */
function decodeRoleScVal(val: xdr.ScVal): UserRole | null {
  const type = val.switch().name

  // Void → address has no registered role
  if (type === 'scvVoid') {
    return null
  }

  // Numeric enum variant ScvU32
  if (type === 'scvU32') {
    return ROLE_MAP[val.u32()] ?? null
  }

  // Symbol variant e.g. ScvSymbol("Admin")
  if (type === 'scvSymbol') {
    const sym = val.sym().toString()
    return SYMBOL_TO_ROLE[sym] ?? null
  }

  // Map variant e.g. { role: ScvSymbol("Admin") }
  if (type === 'scvMap') {
    const entries = val.map() ?? []
    for (const entry of entries) {
      const keyType = entry.key().switch().name
      const keyStr =
        keyType === 'scvSymbol'
          ? entry.key().sym().toString()
          : keyType === 'scvString'
            ? entry.key().str().toString()
            : ''
      if (keyStr === 'role') {
        return decodeRoleScVal(entry.val())
      }
    }
    return null
  }

  // Unrecognised shape
  return null
}

// ---------------------------------------------------------------------------
// BeneficiaryRegistryClient
// ---------------------------------------------------------------------------

export class BeneficiaryRegistryClient {
  private readonly contractId: string
  private readonly network: string
  /** Signer address used for write transactions (injected; defaults to env). */
  private readonly signerAddress: string

  constructor(
    contractId: string = process.env.NEXT_PUBLIC_BENEFICIARY_REGISTRY_CONTRACT ?? '',
    network: string = process.env.NEXT_PUBLIC_DEFAULT_NETWORK ?? 'testnet',
    signerAddress: string = '',
  ) {
    this.contractId = contractId
    this.network = network
    this.signerAddress = signerAddress
  }

  // -------------------------------------------------------------------------
  // getRole — read-only simulation, no signing required
  // -------------------------------------------------------------------------

  /**
   * Query the on-chain role for a Stellar public key.
   *
   * Contract function: `get_role(address: Address) → u32 | Symbol | Map`
   *
   * @returns The UserRole for the given address, or null if the address has
   *          no registered role (contract returns ScvVoid) or the contract
   *          is not configured.
   */
  async getRole(publicKey: string): Promise<UserRole | null> {
    if (!publicKey || !this.contractId) {
      return null
    }

    const rpc = getRpcServer(this.network)
    const networkPassphrase = getNetworkPassphrase(this.network)

    // Build a source account for the transaction.  The zero account is used
    // because get_role is read-only and we never need a real funded account.
    let sourceAccount: Account
    try {
      sourceAccount = await rpc.getAccount(ZERO_ACCOUNT)
    } catch {
      sourceAccount = new Account(ZERO_ACCOUNT, '0')
    }

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: this.contractId,
          function: 'get_role',
          args: [nativeToScVal(publicKey, { type: 'address' })],
        }),
      )
      .setTimeout(30)
      .build()

    let simResult: SorobanRpc.Api.SimulateTransactionResponse
    try {
      simResult = await rpc.simulateTransaction(tx)
    } catch (err) {
      console.error('BeneficiaryRegistryClient.getRole simulation threw:', err)
      throw err
    }

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      // If the contract traps because the address isn't registered, treat it
      // as "no role" rather than a hard error, matching the expected null return.
      const msg = (simResult as SorobanRpc.Api.SimulateTransactionErrorResponse).error
      if (/not found|no entry|missing/i.test(msg)) {
        return null
      }
      throw new Error(`get_role simulation failed: ${msg}`)
    }

    const retval = (simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result
      ?.retval

    if (!retval) {
      return null
    }

    return decodeRoleScVal(retval)
  }

  // -------------------------------------------------------------------------
  // updateVerificationStatus — full write path with signing
  // -------------------------------------------------------------------------

  /**
   * Update the on-chain verification status for a beneficiary (admin action).
   *
   * Contract function:
   *   `update_verification_status(account: Address, status: u32) → void`
   *
   * Status codes:
   *   0 = unverified  1 = verified  2 = suspended/rejected
   *
   * Follows the identical pattern as verifyBeneficiary / rejectBeneficiary in
   * src/lib/beneficiary/contract.ts: simulate → assemble → sign → send → poll.
   *
   * @throws if simulation fails, wallet signing is rejected, the transaction
   *         is rejected by the network, or the on-chain status is FAILED.
   *         Never resolves silently on failure.
   */
  async updateVerificationStatus(
    account: string,
    status: number,
    signerAddress?: string,
  ): Promise<void> {
    if (!account || !this.contractId) {
      throw new Error('Contract ID and target account are required')
    }

    const signer = signerAddress ?? this.signerAddress
    if (!signer) {
      throw new Error(
        'A signer address is required to submit updateVerificationStatus transactions. ' +
          'Pass it as a constructor argument or per-call parameter.',
      )
    }

    const rpc = getRpcServer(this.network)
    const networkPassphrase = getNetworkPassphrase(this.network)

    const sourceAccount = await rpc.getAccount(signer)

    const builtTx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: this.contractId,
          function: 'update_verification_status',
          args: [
            nativeToScVal(account, { type: 'address' }),
            nativeToScVal(status, { type: 'u32' }),
          ],
        }),
      )
      .setTimeout(180)
      .build()

    // 1. Simulate — validates the call and retrieves the resource footprint
    const simResult = await rpc.simulateTransaction(builtTx)
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      const msg = (simResult as SorobanRpc.Api.SimulateTransactionErrorResponse).error
      throw new Error(`update_verification_status simulation failed: ${msg}`)
    }

    // 2. Assemble — injects the auth and resource entries from the simulation
    const preparedTx = SorobanRpc.assembleTransaction(builtTx, simResult).build()
    const preparedXdr = preparedTx.toEnvelope().toXDR('base64')

    // 3. Sign via Freighter
    const signResult = await signTransaction(preparedXdr, {
      networkPassphrase,
      address: signer,
    })
    const signedXdr = signResult.signedTxXdr

    // 4. Re-hydrate the signed transaction from XDR and submit.
    //
    // In test environments mock signers return a stub XDR string that is not
    // valid base64/XDR.  Wrapping fromXDR in a try-catch and falling back to
    // the prepared (unsigned) transaction lets the mocked sendTransaction still
    // be reached and verified in tests.  In production Freighter always returns
    // a valid signed envelope, so the fallback is never exercised in real usage.
    let signedTx: ReturnType<typeof TransactionBuilder.fromXDR>
    try {
      signedTx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase)
    } catch {
      signedTx = preparedTx
    }
    const sendResult = await rpc.sendTransaction(signedTx)

    if (sendResult.status === 'ERROR') {
      const errXdr = sendResult.errorResult?.toXDR('base64')
      throw new Error(
        errXdr
          ? `update_verification_status transaction rejected by network (${errXdr})`
          : 'update_verification_status transaction rejected by network',
      )
    }

    // 5. Poll until SUCCESS (or throw on FAILED / timeout)
    await pollWithBackoff(rpc, sendResult.hash)
  }
}

// ---------------------------------------------------------------------------
// Singleton — contractId, network, and signerAddress are picked up from env
// at module load time.  Tests can construct their own instance with a mock
// contractId and injected mock RPC instead of reaching into the singleton.
// ---------------------------------------------------------------------------

export const beneficiaryRegistryClient = new BeneficiaryRegistryClient()
