import { WalletService, FREIGHTER_NETWORK_MAP } from './wallet-service'
import { useWalletStore } from '@/store/wallet-store'
import { __clearSorobanSDKCache } from '@/lib/soroban/sdk'

jest.mock('@stellar/freighter-api', () => ({
  isConnected: jest.fn(),
  getAddress: jest.fn(),
  signTransaction: jest.fn(),
  getNetwork: jest.fn(),
}))

jest.mock('@stellar/wallet-sdk', () => ({
  WalletKit: jest.fn().mockImplementation(() => ({
    getAddress: jest.fn(),
  })),
}))

import * as freighterApi from '@stellar/freighter-api'

describe('FREIGHTER_NETWORK_MAP', () => {
  it('maps testnet to TESTNET', () => {
    expect(FREIGHTER_NETWORK_MAP.testnet).toBe('TESTNET')
  })
  it('maps mainnet to PUBLIC', () => {
    expect(FREIGHTER_NETWORK_MAP.mainnet).toBe('PUBLIC')
  })
  it('maps futurenet to FUTURENET', () => {
    expect(FREIGHTER_NETWORK_MAP.futurenet).toBe('FUTURENET')
  })
  it('maps standalone to STANDALONE', () => {
    expect(FREIGHTER_NETWORK_MAP.standalone).toBe('STANDALONE')
  })
})

describe('WalletService.signTransaction', () => {
  beforeEach(() => {
    __clearSorobanSDKCache()
    jest.clearAllMocks()
    useWalletStore.setState({
      isConnected: false,
      address: null,
      publicKey: null,
      network: 'testnet',
      balance: '0',
    })
    ;(freighterApi.signTransaction as jest.Mock).mockResolvedValue({
      signedTxXdr: 'signed-xdr',
      signerAddress: 'GABC123',
    })
  })

  it('passes the mainnet passphrase (not testnet) to Freighter when store network is mainnet', async () => {
    useWalletStore.setState({ network: 'mainnet' })
    const service = new WalletService()

    await service.signTransaction('xdr-blob')

    expect(freighterApi.signTransaction).toHaveBeenCalledWith(
      'xdr-blob',
      expect.objectContaining({ networkPassphrase: 'Public Global Stellar Network ; September 2015' })
    )
  })

  it('passes the testnet passphrase to Freighter when store network is testnet', async () => {
    useWalletStore.setState({ network: 'testnet' })
    const service = new WalletService()

    await service.signTransaction('xdr-blob')

    expect(freighterApi.signTransaction).toHaveBeenCalledWith(
      'xdr-blob',
      expect.objectContaining({ networkPassphrase: 'Test SDF Network ; September 2015' })
    )
  })

  it('reads the network from the store at call time, not a hardcoded literal', async () => {
    const service = new WalletService()

    useWalletStore.setState({ network: 'futurenet' })
    await service.signTransaction('xdr-1')
    expect(freighterApi.signTransaction).toHaveBeenLastCalledWith(
      'xdr-1',
      expect.objectContaining({ networkPassphrase: 'Test SDF Future Network ; October 2022' })
    )

    useWalletStore.setState({ network: 'mainnet' })
    await service.signTransaction('xdr-2')
    expect(freighterApi.signTransaction).toHaveBeenLastCalledWith(
      'xdr-2',
      expect.objectContaining({ networkPassphrase: 'Public Global Stellar Network ; September 2015' })
    )
  })

  it('allows an explicit network override', async () => {
    useWalletStore.setState({ network: 'testnet' })
    const service = new WalletService()

    await service.signTransaction('xdr-blob', 'mainnet')

    expect(freighterApi.signTransaction).toHaveBeenCalledWith(
      'xdr-blob',
      expect.objectContaining({ networkPassphrase: 'Public Global Stellar Network ; September 2015' })
    )
  })
})

describe('WalletService.getNetwork', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns the short network name reported by Freighter', async () => {
    ;(freighterApi.getNetwork as jest.Mock).mockResolvedValue({
      network: 'PUBLIC',
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
    })
    const service = new WalletService()
    await expect(service.getNetwork()).resolves.toBe('PUBLIC')
  })

  it('falls back to TESTNET on error', async () => {
    ;(freighterApi.getNetwork as jest.Mock).mockResolvedValue({ error: 'not connected' })
    const service = new WalletService()
    await expect(service.getNetwork()).resolves.toBe('TESTNET')
  })
})
