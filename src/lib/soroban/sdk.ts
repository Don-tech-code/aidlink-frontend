import { SorobanRpc, Horizon, xdr, TransactionBuilder, Networks, Operation, BASE_FEE } from '@stellar/stellar-sdk'
import { NETWORKS as HORIZON_NETWORKS, SOROBAN_NETWORKS } from '@/config/constants'

export interface NetworkConfig {
  networkPassphrase: string
  rpcUrl: string
}

export type NetworkName = 'mainnet' | 'testnet' | 'futurenet' | 'standalone'

// NOTE: 'mainnet' was previously missing from this map entirely — any call
// to `new SorobanSDK('mainnet')` would throw when reading `NETWORKS.mainnet`.
export const NETWORKS: Record<NetworkName, NetworkConfig> = {
  mainnet: {
    networkPassphrase: Networks.PUBLIC,
    rpcUrl: SOROBAN_NETWORKS.MAINNET.rpcUrl,
  },
  testnet: {
    networkPassphrase: Networks.TESTNET,
    rpcUrl: SOROBAN_NETWORKS.TESTNET.rpcUrl,
  },
  futurenet: {
    networkPassphrase: Networks.FUTURENET,
    rpcUrl: SOROBAN_NETWORKS.FUTURENET.rpcUrl,
  },
  standalone: {
    networkPassphrase: Networks.STANDALONE,
    rpcUrl: SOROBAN_NETWORKS.STANDALONE.rpcUrl,
  },
}

// ---------------------------------------------------------------------------
// Typed errors (issue #85)
// ---------------------------------------------------------------------------
// Distinct classes so callers can `instanceof`-branch on *why* a submission
// failed instead of pattern-matching a generic Error's message string.

/** Simulation itself failed (e.g. bad args, contract trap during preflight). */
export class SorobanSimulationError extends Error {
  constructor(
    message: string,
    /** The raw simulateTransaction response, kept for debugging. */
    public readonly rawResponse: unknown
  ) {
    super(message)
    this.name = 'SorobanSimulationError'
  }
}

/** The transaction reached the ledger but the contract invocation failed. */
export class SorobanContractError extends Error {
  constructor(
    message: string,
    /** The resultXdr from the failed getTransaction/sendTransaction response. */
    public readonly resultXdr: unknown
  ) {
    super(message)
    this.name = 'SorobanContractError'
  }
}

/** Polling exceeded pollTimeoutMs without the transaction reaching a terminal state. */
export class SorobanTimeoutError extends Error {
  constructor(
    message: string,
    /** The submitted transaction's hash, so the caller can keep checking manually. */
    public readonly txHash?: string
  ) {
    super(message)
    this.name = 'SorobanTimeoutError'
  }
}

/**
 * Thrown by getBalance when Horizon returns a 404 for the given address,
 * indicating the account has never been funded on this network.
 * Callers can `instanceof`-check this to show "account not funded" UI
 * rather than a generic network-error message.
 */
export class AccountNotFoundError extends Error {
  constructor(
    /** The address that was not found on the network. */
    public readonly address: string
  ) {
    super(`Account not found on network: ${address}`)
    this.name = 'AccountNotFoundError'
  }
}

export interface SorobanSDKOptions {
  /**
   * Soroban fees are resource-based, not flat. The resource-fee portion of
   * the simulation's minResourceFee estimate is multiplied by this before
   * the transaction is assembled, so submissions aren't rejected for
   * underpaying resource fees on a busy network. Default 1.5.
   */
  feeMultiplier?: number
  /** How often to poll getTransaction while awaiting finality. Default 2000ms. */
  pollIntervalMs?: number
  /** How long to poll before rejecting with SorobanTimeoutError. Default 30000ms. */
  pollTimeoutMs?: number
}

export interface InvokeContractParams {
  contractId: string
  method: string
  args?: xdr.ScVal[]
  /** The public key whose account funds and sequences this transaction. */
  sourcePublicKey: string
  /**
   * Signs the assembled transaction's XDR and returns the signed envelope's
   * XDR. Keeps this SDK decoupled from the wallet layer — WalletService is
   * never imported here.
   */
  signer: (xdr: string) => Promise<string>
}

export interface InvokeContractResult {
  txHash: string
  status: SorobanRpc.Api.GetTransactionStatus.SUCCESS
  returnValue?: xdr.ScVal
}

export class SorobanSDK {
  private rpc: SorobanRpc.Server
  /** Horizon REST API server for the same network — used by getBalance. */
  private horizon: Horizon.Server
  /**
   * Public and readonly so callers (and tests) can read the passphrase a
   * given SDK instance is bound to without an extra getter call, e.g.
   * `getSorobanSDK('mainnet').networkPassphrase`.
   */
  readonly network: NetworkName
  readonly networkPassphrase: string

  private readonly feeMultiplier: number
  private readonly pollIntervalMs: number
  private readonly pollTimeoutMs: number

  constructor(network: NetworkName = 'testnet', options: SorobanSDKOptions = {}) {
    const config = NETWORKS[network]
    this.rpc = new SorobanRpc.Server(config.rpcUrl, {
      allowHttp: network === 'standalone',
    })
    this.horizon = new Horizon.Server(this.getHorizonUrl(network), {
      allowHttp: network === 'standalone',
    })
    this.network = network
    this.networkPassphrase = config.networkPassphrase

    this.feeMultiplier = options.feeMultiplier ?? 1.5
    this.pollIntervalMs = options.pollIntervalMs ?? 2000
    this.pollTimeoutMs = options.pollTimeoutMs ?? 30000
  }

  /**
   * Maps a NetworkName to the corresponding Horizon REST API base URL,
   * using the NETWORKS constant from src/config/constants.ts.
   */
  private getHorizonUrl(network: NetworkName): string {
    const map: Record<NetworkName, string> = {
      mainnet: HORIZON_NETWORKS.MAINNET,
      testnet: HORIZON_NETWORKS.TESTNET,
      futurenet: HORIZON_NETWORKS.FUTURENET,
      standalone: HORIZON_NETWORKS.STANDALONE,
    }
    return map[network]
  }

  async getAccount(address: string) {
    try {
      const account = await this.rpc.getAccount(address)
      return account
    } catch (error) {
      console.error('Error fetching account:', error)
      throw error
    }
  }

  async getBalance(address: string): Promise<string> {
    try {
      const account = await this.horizon.loadAccount(address)
      const nativeBalance = account.balances.find(
        (b): b is Horizon.ServerApi.BalanceLine<'native'> => b.asset_type === 'native'
      )
      if (!nativeBalance) {
        // This should not happen for a funded account — native XLM balance
        // is always present — but handle defensively.
        return '0.0000000'
      }
      // Enforce exactly 7 decimal places to match Stellar's stroop precision
      // and be directly displayable in the fee UI without further formatting.
      return parseFloat(nativeBalance.balance).toFixed(7)
    } catch (error) {
      // Horizon 404 means the account has never been funded on this network.
      // Propagate as a typed error so callers can show "account not funded" UI.
      if (
        error &&
        typeof error === 'object' &&
        'response' in error &&
        (error as { response?: { status?: number } }).response?.status === 404
      ) {
        throw new AccountNotFoundError(address)
      }
      console.error('Error fetching balance:', error)
      throw error
    }
  }

  /**
   * Runs the full Soroban write-transaction lifecycle as a single atomic
   * async operation (issue #85): fetch account → build → simulate →
   * (restore footprint if needed) → assemble → sign → submit → poll until
   * SUCCESS/FAILED/timeout. Only resolves on a confirmed SUCCESS; every
   * other outcome rejects with one of SorobanSimulationError,
   * SorobanContractError, or SorobanTimeoutError.
   */
  async invokeContract(params: InvokeContractParams): Promise<InvokeContractResult> {
    const { contractId, method, sourcePublicKey, signer } = params
    const args = params.args ?? []

    const account = await this.rpc.getAccount(sourcePublicKey)

    const buildInvokeTx = () =>
      new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(Operation.invokeContractFunction({ contract: contractId, function: method, args }))
        .setTimeout(30)
        .build()

    let builtTx = buildInvokeTx()
    let simulation = await this.rpc.simulateTransaction(builtTx)

    if (SorobanRpc.Api.isSimulationError(simulation)) {
      throw new SorobanSimulationError(`Simulation failed: ${simulation.error}`, simulation)
    }

    if (SorobanRpc.Api.isSimulationRestore(simulation)) {
      // Ledger entries the invocation needs have expired. Restore them in a
      // separate transaction, wait for it to finalize, then rebuild and
      // re-simulate the original invocation against the account's new
      // sequence number and the now-live footprint.
      await this.restoreFootprint(account, simulation.restorePreamble, signer)

      builtTx = buildInvokeTx()
      simulation = await this.rpc.simulateTransaction(builtTx)

      if (SorobanRpc.Api.isSimulationError(simulation)) {
        throw new SorobanSimulationError(
          `Simulation failed after footprint restoration: ${simulation.error}`,
          simulation
        )
      }
    }

    if (!SorobanRpc.Api.isSimulationSuccess(simulation)) {
      throw new SorobanSimulationError('Simulation did not return a usable result', simulation)
    }

    // Pad the resource-fee estimate before assembling — Soroban fees are
    // resource-based, and the raw minResourceFee is only a bare minimum.
    const paddedSimulation = {
      ...simulation,
      minResourceFee: String(Math.ceil(Number(simulation.minResourceFee) * this.feeMultiplier)),
    }

    const preparedTx = SorobanRpc.assembleTransaction(builtTx, paddedSimulation).build()

    const signedXdr = await signer(preparedTx.toXDR())
    const signedTx = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase)

    const sendResult = await this.rpc.sendTransaction(signedTx)

    if (sendResult.status === 'ERROR') {
      throw new SorobanContractError(
        'The network rejected the transaction before it reached the ledger',
        sendResult.errorResult
      )
    }

    const finalResult = await this.pollTransaction(sendResult.hash)

    return {
      txHash: sendResult.hash,
      status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
      returnValue: finalResult.returnValue,
    }
  }

  /**
   * Builds, signs, submits, and awaits finality for a RestoreFootprint
   * operation using the transactionData/fee estimate from a
   * SimulateTransactionRestoreResponse. Rejects (via pollTransaction) if the
   * restore itself fails or times out — the caller should not attempt the
   * original invocation in that case.
   */
  private async restoreFootprint(
    account: Awaited<ReturnType<SorobanRpc.Server['getAccount']>>,
    restorePreamble: SorobanRpc.Api.SimulateTransactionRestoreResponse['restorePreamble'],
    signer: (xdr: string) => Promise<string>
  ): Promise<void> {
    const paddedRestoreFee = Math.ceil(Number(restorePreamble.minResourceFee) * this.feeMultiplier)
    const totalFee = String(paddedRestoreFee + Number(BASE_FEE))

    const restoreTx = new TransactionBuilder(account, {
      fee: totalFee,
      networkPassphrase: this.networkPassphrase,
    })
      .setSorobanData(restorePreamble.transactionData.build())
      .addOperation(Operation.restoreFootprint({}))
      .setTimeout(30)
      .build()

    const signedXdr = await signer(restoreTx.toXDR())
    const signedTx = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase)

    const sendResult = await this.rpc.sendTransaction(signedTx)

    if (sendResult.status === 'ERROR') {
      throw new SorobanContractError('Footprint restoration was rejected by the network', sendResult.errorResult)
    }

    await this.pollTransaction(sendResult.hash)
  }

  /**
   * Polls getTransaction on a fixed interval via recursive setTimeout (not
   * setInterval — so a slow response can never cause two polls to overlap)
   * until the transaction reaches SUCCESS, FAILED, or pollTimeoutMs elapses.
   */
  private pollTransaction(
    txHash: string
  ): Promise<SorobanRpc.Api.GetSuccessfulTransactionResponse> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now()
      let timer: ReturnType<typeof setTimeout> | undefined

      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer)
      }

      const check = async () => {
        let response: SorobanRpc.Api.GetTransactionResponse | { status: string; resultXdr?: unknown }
        try {
          response = await this.rpc.getTransaction(txHash)
        } catch (error) {
          cleanup()
          reject(error)
          return
        }

        if (response.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
          cleanup()
          resolve(response as SorobanRpc.Api.GetSuccessfulTransactionResponse)
          return
        }

        if (response.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
          cleanup()
          reject(
            new SorobanContractError(
              decodeTransactionResultMessage((response as SorobanRpc.Api.GetFailedTransactionResponse).resultXdr),
              (response as SorobanRpc.Api.GetFailedTransactionResponse).resultXdr
            )
          )
          return
        }

        // NOT_FOUND (or any other non-terminal status) — still processing.
        if (Date.now() - startedAt >= this.pollTimeoutMs) {
          cleanup()
          reject(
            new SorobanTimeoutError(
              `Transaction ${txHash} did not reach a final state within ${this.pollTimeoutMs}ms`,
              txHash
            )
          )
          return
        }

        timer = setTimeout(check, this.pollIntervalMs)
      }

      check()
    })
  }

  async getTransactionStatus(txHash: string) {
    try {
      const result = await this.rpc.getTransaction(txHash)
      return result
    } catch (error) {
      console.error('Error fetching transaction status:', error)
      throw error
    }
  }

  getNetworkPassphrase(): string {
    return this.networkPassphrase
  }
}

/**
 * Best-effort human-readable message from a failed transaction's resultXdr.
 * resultXdr may already be a parsed xdr.TransactionResult (the real RPC
 * client's shape) or a raw base64 string (as seen in simplified test
 * mocks) — handle both without throwing.
 */
function decodeTransactionResultMessage(resultXdr: unknown): string {
  try {
    const parsed =
      typeof resultXdr === 'string' ? xdr.TransactionResult.fromXDR(resultXdr, 'base64') : (resultXdr as xdr.TransactionResult)
    return `Transaction failed: ${parsed.result().switch().name}`
  } catch {
    return 'Transaction failed'
  }
}

// ---------------------------------------------------------------------------
// Factory / cache (see issue #105: network-switching architecture fix)
// ---------------------------------------------------------------------------
//
// Previously `sorobanSDK` was a single module-level instance created once at
// import time, permanently bound to whatever network it was constructed
// with. Switching networks in the UI never recreated it, so every RPC call
// silently kept hitting the original network regardless of the wallet
// store's current `network` value.
//
// getSorobanSDK()/invalidateSorobanSDK() replace that: callers ask for the
// SDK for a specific network, and get a cached instance per network,
// recreated on demand after invalidation (e.g. on network switch).

const sdkCache = new Map<NetworkName, SorobanSDK>()

/**
 * Returns a cached SorobanSDK instance for the given network, creating one
 * if it doesn't already exist. Synchronous by design — the SorobanSDK
 * constructor itself is synchronous, so this must not become async.
 */
export function getSorobanSDK(network: NetworkName = 'testnet'): SorobanSDK {
  if (!sdkCache.has(network)) {
    sdkCache.set(network, new SorobanSDK(network))
  }
  return sdkCache.get(network)!
}

/**
 * Drops the cached SDK instance for a network so the next call to
 * getSorobanSDK() for that network constructs a fresh instance.
 */
export function invalidateSorobanSDK(network: NetworkName): void {
  sdkCache.delete(network)
}

/** Test-only helper to reset cache state between test cases. */
export function __clearSorobanSDKCache(): void {
  sdkCache.clear()
}

/**
 * @deprecated Use `getSorobanSDK(network)` with the current network read
 * from the wallet store instead of this module-level singleton. This export
 * is kept only for backward compatibility with code that has not yet
 * migrated off the old singleton pattern. It always points at 'testnet' and
 * will NOT reflect the user's actual selected network — do not use it for
 * any network-sensitive operation (signing, balances, contract calls).
 */
export const sorobanSDK = getSorobanSDK('testnet')
