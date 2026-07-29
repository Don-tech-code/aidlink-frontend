import { NETWORKS } from '@/config/constants'
import type { WalletState } from '@/types'

export type HorizonNetwork = WalletState['network']

export function getHorizonUrl(network: HorizonNetwork): string {
  const map: Record<HorizonNetwork, string> = {
    mainnet: NETWORKS.MAINNET,
    testnet: NETWORKS.TESTNET,
    futurenet: NETWORKS.FUTURENET,
    standalone: NETWORKS.STANDALONE,
  }
  return map[network]
}

export function cursorStorageKey(
  publicKey: string,
  network: HorizonNetwork
): string {
  return `aidlink:horizon-tx-cursor:${network}:${publicKey}`
}
