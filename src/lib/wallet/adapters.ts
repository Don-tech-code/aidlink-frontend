import freighterApi from '@stellar/freighter-api'
import { WalletNotConnectedError, WalletSigningError } from './errors'

export type StellarNetwork = 'mainnet' | 'testnet' | 'futurenet' | 'standalone'

export interface WalletInfo {
  publicKey: string
  address: string
  network: string
}

export interface WalletAdapter {
  readonly walletId: string
  connect(): Promise<WalletInfo>
  sign(xdr: string, network: StellarNetwork): Promise<string>
  getNetwork(): Promise<string>
  disconnect(): Promise<void>
}

/**
 * Map StellarNetwork identifier to the Stellar network passphrase.
 */
function networkToPassphrase(network: StellarNetwork): string {
  const passphraseMap: Record<StellarNetwork, string> = {
    mainnet: 'Public Global Stellar Network ; September 2015',
    testnet: 'Test SDF Network ; September 2015',
    futurenet: 'Test SDF Future Network ; October 2022',
    standalone: 'Standalone Network ; February 2017',
  }
  return passphraseMap[network]
}

/**
 * FreighterAdapter wraps @stellar/freighter-api ^6.0.1
 * The v6 API returns objects instead of raw primitives, and uses networkPassphrase
 * instead of the deprecated network string in signTransaction.
 */
export class FreighterAdapter implements WalletAdapter {
  readonly walletId = 'freighter'

  async connect(): Promise<WalletInfo> {
    const connectedResult = await freighterApi.isConnected()
    if (!connectedResult.isConnected) {
      throw new WalletNotConnectedError('Freighter is not connected or permission not granted')
    }

    try {
      const addressResult = await freighterApi.getAddress()
      if (addressResult.error) {
        throw new WalletNotConnectedError(
          `Freighter returned an error: ${addressResult.error}`
        )
      }

      const networkResult = await freighterApi.getNetwork()
      if (networkResult.error) {
        throw new WalletNotConnectedError(
          `Failed to get network from Freighter: ${networkResult.error}`
        )
      }

      return {
        publicKey: addressResult.address,
        address: addressResult.address,
        network: networkResult.network,
      }
    } catch (error) {
      if (error instanceof WalletNotConnectedError) throw error
      throw new WalletNotConnectedError(
        `Failed to connect to Freighter: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  }

  async sign(xdr: string, network: StellarNetwork): Promise<string> {
    const connectedResult = await freighterApi.isConnected()
    if (!connectedResult.isConnected) {
      throw new WalletNotConnectedError('Freighter is not connected')
    }

    try {
      // Use networkPassphrase (Freighter API v6 — the two-arg string form is deprecated)
      const result = await freighterApi.signTransaction(xdr, {
        networkPassphrase: networkToPassphrase(network),
      })
      if (result.error) {
        throw new WalletSigningError(`Freighter returned an error: ${result.error}`)
      }
      return result.signedTxXdr
    } catch (error) {
      if (error instanceof WalletSigningError) throw error
      throw new WalletSigningError(
        `Failed to sign transaction with Freighter: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error
      )
    }
  }

  async getNetwork(): Promise<string> {
    try {
      const result = await freighterApi.getNetwork()
      if (result.error) {
        throw new WalletNotConnectedError(`Failed to get network from Freighter: ${result.error}`)
      }
      return result.network
    } catch (error) {
      if (error instanceof WalletNotConnectedError) throw error
      throw new WalletNotConnectedError('Failed to get network from Freighter')
    }
  }

  async disconnect(): Promise<void> {
    // Freighter doesn't have a programmatic disconnect method.
    // The user must disconnect from the extension itself.
    // This method is a no-op for interface compatibility.
  }
}

/**
 * WalletKitAdapter for Rabet and XBull wallets.
 *
 * NOTE: @stellar/wallet-sdk ^0.11.2 does not export StellarWalletKit.
 * The correct package for StellarWalletKit is `stellar-wallets-kit` (Creit-Tech).
 * Until that package is added to the project, this is a typed stub that clearly
 * communicates the wallet is not yet supported rather than silently failing.
 *
 * To complete the implementation:
 *   1. npm install stellar-wallets-kit
 *   2. import { StellarWalletKit, WalletNetwork } from 'stellar-wallets-kit'
 *   3. Replace stub with real initialization using WalletNetwork enum (not string)
 */
export class WalletKitAdapter implements WalletAdapter {
  readonly walletId: string

  constructor(walletId: 'rabet' | 'xbull', private readonly network: StellarNetwork) {
    this.walletId = walletId
  }

  async connect(): Promise<WalletInfo> {
    throw new WalletNotConnectedError(
      `${this.walletId} is not yet supported. Please use the Freighter wallet.`
    )
  }

  async sign(_xdr: string, _network: StellarNetwork): Promise<string> {
    throw new WalletSigningError(
      `${this.walletId} is not yet supported. Please use the Freighter wallet.`
    )
  }

  async getNetwork(): Promise<string> {
    return this.network
  }

  async disconnect(): Promise<void> {
    // No-op
  }
}
