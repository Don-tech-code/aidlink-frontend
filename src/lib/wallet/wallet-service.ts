import * as freighterApi from '@stellar/freighter-api'
import {
  WalletAdapter,
  FreighterAdapter,
  WalletKitAdapter,
  type StellarNetwork,
  type WalletInfo,
} from './adapters'
import { NoActiveWalletError } from './errors'
import { getSorobanSDK, type NetworkName } from '../soroban/sdk'
import { useWalletStore } from '@/store/wallet-store'

export type { WalletInfo, StellarNetwork }

export type WalletId = 'freighter' | 'rabet' | 'xbull'

/**
 * Freighter's own short network names, as returned by getNetwork()/
 * getNetworkDetails() in @stellar/freighter-api. Freighter has no concept
 * of 'standalone' — that carve-out is handled separately wherever this map
 * is consulted (see NetworkGuard and useWalletEnhanced.switchNetwork).
 */
export type FreighterNetwork = 'TESTNET' | 'PUBLIC' | 'FUTURENET' | 'STANDALONE'

export const FREIGHTER_NETWORK_MAP: Record<NetworkName, FreighterNetwork> = {
  testnet: 'TESTNET',
  mainnet: 'PUBLIC',
  futurenet: 'FUTURENET',
  standalone: 'STANDALONE',
}

const FREIGHTER_TO_APP_NETWORK: Record<string, NetworkName> = {
  TESTNET: 'testnet',
  PUBLIC: 'mainnet',
  FUTURENET: 'futurenet',
}

export class WalletService {
  private _activeAdapter: WalletAdapter | null = null
  private _adapterCache: Map<string, WalletAdapter> = new Map()
  private _networkChangeUnsubscribe: (() => void) | null = null

  /**
   * Connect to a wallet and set it as the active adapter.
   */
  async connect(walletId: WalletId, network: StellarNetwork): Promise<WalletInfo> {
    const adapterKey = `${walletId}-${network}`

    let adapter: WalletAdapter
    if (this._adapterCache.has(adapterKey)) {
      adapter = this._adapterCache.get(adapterKey)!
    } else {
      adapter = this._createAdapter(walletId, network)
      this._adapterCache.set(adapterKey, adapter)
    }

    const walletInfo = await adapter.connect()
    this._activeAdapter = adapter

    if (walletId === 'freighter') {
      await this._subscribeToFreighterNetworkChange()
    }

    return walletInfo
  }

  /**
   * Convenience Freighter connect used by `useWalletEnhanced`.
   * Sets Freighter as the active adapter so later `sign`/`disconnect` work.
   */
  async connectFreighter(): Promise<WalletInfo> {
    try {
      const freighterNetwork = await this.getNetwork()
      const network = FREIGHTER_TO_APP_NETWORK[freighterNetwork] ?? 'testnet'
      return await this.connect('freighter', network)
    } catch (error) {
      console.error('Error connecting Freighter:', error)
      throw new Error('Failed to connect Freighter wallet')
    }
  }

  async isFreighterConnected(): Promise<boolean> {
    try {
      const { isConnected, error } = await freighterApi.isConnected()
      if (error) return false
      return isConnected
    } catch (error) {
      console.error('Error checking Freighter connection:', error)
      return false
    }
  }

  /**
   * Sign via the active adapter registry.
   */
  async sign(xdr: string): Promise<string> {
    if (!this._activeAdapter) {
      throw new NoActiveWalletError('No wallet is connected. Call connect() first.')
    }

    const currentNetwork = this.getCurrentNetwork()
    return await this._activeAdapter.sign(xdr, currentNetwork)
  }

  /**
   * Sign against the currently active network using Freighter directly.
   * Kept for call sites / tests that rely on passphrase resolution from the
   * Soroban SDK factory (issue #105).
   */
  async signTransaction(xdr: string, network?: NetworkName): Promise<string> {
    try {
      const activeNetwork = network ?? useWalletStore.getState().network
      const networkPassphrase = getSorobanSDK(activeNetwork).networkPassphrase

      const { signedTxXdr, error } = await freighterApi.signTransaction(xdr, {
        networkPassphrase,
      })
      if (error) {
        throw new Error(String(error))
      }
      return signedTxXdr
    } catch (error) {
      console.error('Error signing transaction:', error)
      throw new Error('Failed to sign transaction')
    }
  }

  async disconnect(): Promise<void> {
    if (this._activeAdapter) {
      await this._activeAdapter.disconnect()
      this._activeAdapter = null
    }

    if (this._networkChangeUnsubscribe) {
      this._networkChangeUnsubscribe()
      this._networkChangeUnsubscribe = null
    }
  }

  /**
   * Returns Freighter's current short network name (e.g. 'TESTNET', 'PUBLIC').
   */
  async getNetwork(): Promise<FreighterNetwork> {
    try {
      const { network, error } = await freighterApi.getNetwork()
      if (error || !network) {
        return 'TESTNET'
      }
      return network as FreighterNetwork
    } catch (error) {
      console.error('Error getting network:', error)
      return 'TESTNET'
    }
  }

  /**
   * Get the current network from WalletStore (single source of truth).
   */
  getCurrentNetwork(): StellarNetwork {
    if (typeof window !== 'undefined') {
      try {
        return useWalletStore.getState().network as StellarNetwork
      } catch (error) {
        console.warn('Failed to get network from WalletStore', error)
        throw new Error('Unable to determine current network from WalletStore')
      }
    }
    throw new Error('WalletStore is not available in this environment')
  }

  getActiveWalletId(): WalletId | null {
    if (!this._activeAdapter) {
      return null
    }
    return this._activeAdapter.walletId as WalletId
  }

  isConnected(): boolean {
    return this._activeAdapter !== null
  }

  private _createAdapter(walletId: WalletId, network: StellarNetwork): WalletAdapter {
    if (walletId === 'freighter') {
      return new FreighterAdapter()
    }
    if (walletId === 'rabet' || walletId === 'xbull') {
      return new WalletKitAdapter(walletId, network)
    }
    throw new Error(`Unsupported wallet: ${walletId}`)
  }

  private async _subscribeToFreighterNetworkChange(): Promise<void> {
    try {
      const api = freighterApi as typeof freighterApi & {
        on?: (event: string, handler: (network: string) => void) => void
        off?: (event: string, handler: (network: string) => void) => void
      }

      if (typeof api.on !== 'function') {
        return
      }

      const handler = (network: string) => {
        if (typeof window === 'undefined') return
        try {
          useWalletStore.getState().switchNetwork(network as StellarNetwork)
        } catch (error) {
          console.error('Failed to sync network change to WalletStore', error)
        }
      }

      api.on('networkChanged', handler)

      this._networkChangeUnsubscribe = () => {
        if (typeof api.off === 'function') {
          api.off('networkChanged', handler)
        }
      }
    } catch (error) {
      console.warn('Freighter network change subscription not available', error)
    }
  }
}

export const walletService = new WalletService()
