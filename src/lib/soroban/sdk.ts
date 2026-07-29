import { SorobanRpc, xdr, TransactionBuilder, Networks, Operation, Account } from '@stellar/stellar-sdk'
import { SOROBAN_NETWORKS } from '@/config/constants'

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

export class SorobanSDK {
  private rpc: SorobanRpc.Server
  /**
   * Public and readonly so callers (and tests) can read the passphrase a
   * given SDK instance is bound to without an extra getter call, e.g.
   * `getSorobanSDK('mainnet').networkPassphrase`.
   */
  readonly network: NetworkName
  readonly networkPassphrase: string

  constructor(network: NetworkName = 'testnet') {
    const config = NETWORKS[network]
    this.rpc = new SorobanRpc.Server(config.rpcUrl, {
      allowHttp: network === 'standalone',
    })
    this.network = network
    this.networkPassphrase = config.networkPassphrase
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
      // SorobanRpc.Server.getAccount returns a stellar-base Account (sequence only).
      // To get XLM balance we must query Horizon.
      // For now return '0' as a safe fallback; balance display is non-critical for
      // contract interaction. A full implementation should use a Horizon.Server instance.
      await this.getAccount(address) // validate the account exists
      return '0'
    } catch (error) {
      console.error('Error fetching balance:', error)
      throw error
    }
  }

  async invokeContract(
    contractId: string,
    method: string,
    args: xdr.ScVal[] = []
  ): Promise<xdr.ScVal> {
    try {
      // Build a stub account for the transaction builder (sequence is managed server-side)
      const sourceAccount = new Account(contractId, '0')

      const tx = new TransactionBuilder(sourceAccount, {
        fee: '100',
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: contractId,
            function: method,
            args,
          })
        )
        .setTimeout(30)
        .build()

      const result = await this.rpc.simulateTransaction(tx)

      if (SorobanRpc.Api.isSimulationSuccess(result) && result.result) {
        return result.result.retval
      }
      throw new Error('No result from contract invocation')
    } catch (error) {
      console.error('Error invoking contract:', error)
      throw error
    }
  }

  async submitTransaction(transaction: xdr.Transaction): Promise<string> {
    try {
      // Deserialize the XDR transaction envelope before submitting
      const txEnvelope = xdr.TransactionEnvelope.fromXDR(transaction.toXDR())
      const tx = TransactionBuilder.fromXDR(txEnvelope, this.networkPassphrase)
      const result = await this.rpc.sendTransaction(tx)
      if (result.errorResult) {
        throw new Error('Transaction failed')
      }
      return result.hash
    } catch (error) {
      console.error('Error submitting transaction:', error)
      throw error
    }
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
