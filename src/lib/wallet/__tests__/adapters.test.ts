import { FreighterAdapter, WalletKitAdapter } from '../adapters'
import { WalletNotConnectedError, WalletSigningError } from '../errors'
import freighterApi from '@stellar/freighter-api'

// Mock the wallet APIs
jest.mock('@stellar/freighter-api', () => ({
  __esModule: true,
  default: {
    isConnected: jest.fn(),
    getAddress: jest.fn(),
    getNetwork: jest.fn(),
    signTransaction: jest.fn(),
  },
}))

describe('FreighterAdapter', () => {
  let adapter: FreighterAdapter
  const mockFreighterApi = freighterApi as jest.Mocked<typeof freighterApi>

  beforeEach(() => {
    jest.clearAllMocks()
    adapter = new FreighterAdapter()
  })

  describe('connect', () => {
    it('should throw WalletNotConnectedError when isConnected returns false', async () => {
      mockFreighterApi.isConnected = jest.fn().mockResolvedValue({ isConnected: false })

      await expect(adapter.connect()).rejects.toThrow(WalletNotConnectedError)
      await expect(adapter.connect()).rejects.toThrow('Freighter is not connected or permission not granted')
    })

    it('should return wallet info when connected successfully', async () => {
      const mockPublicKey = 'GCZJM35NKGVK47BB4SPBDV25477PZYIYPVVG453LPYFNXLS3FGHDXOCM'
      mockFreighterApi.isConnected = jest.fn().mockResolvedValue({ isConnected: true })
      mockFreighterApi.getAddress = jest.fn().mockResolvedValue({ address: mockPublicKey })
      mockFreighterApi.getNetwork = jest.fn().mockResolvedValue({ 
        network: 'testnet',
        networkPassphrase: 'Test SDF Network ; September 2015'
      })

      const result = await adapter.connect()

      expect(result).toEqual({
        publicKey: mockPublicKey,
        address: mockPublicKey,
        network: 'testnet',
      })
    })
  })

  describe('sign', () => {
    it('should call signTransaction with networkPassphrase (object-param form, not two-arg string)', async () => {
      const mockXdr = 'AAAAAgAAAAA...'
      const mockSignedXdr = 'AAAAAgAAAAB...'
      
      mockFreighterApi.isConnected = jest.fn().mockResolvedValue({ isConnected: true })
      mockFreighterApi.signTransaction = jest.fn().mockResolvedValue({ 
        signedTxXdr: mockSignedXdr,
        signerAddress: 'G...'
      })

      const result = await adapter.sign(mockXdr, 'testnet')

      // Verify the object-param form is used with networkPassphrase (Freighter API v6)
      expect(mockFreighterApi.signTransaction).toHaveBeenCalledWith(mockXdr, {
        networkPassphrase: 'Test SDF Network ; September 2015',
      })
      expect(mockFreighterApi.signTransaction).toHaveBeenCalledTimes(1)
      expect(result).toBe(mockSignedXdr)
    })

    it('should throw WalletNotConnectedError when isConnected returns false', async () => {
      mockFreighterApi.isConnected = jest.fn().mockResolvedValue({ isConnected: false })

      await expect(adapter.sign('test-xdr', 'testnet')).rejects.toThrow(WalletNotConnectedError)
    })

    it('should throw WalletSigningError when signing fails', async () => {
      mockFreighterApi.isConnected = jest.fn().mockResolvedValue({ isConnected: true })
      mockFreighterApi.signTransaction = jest.fn().mockRejectedValue(new Error('User rejected'))

      await expect(adapter.sign('test-xdr', 'testnet')).rejects.toThrow(WalletSigningError)
    })
  })

  describe('walletId', () => {
    it('should have walletId as "freighter"', () => {
      expect(adapter.walletId).toBe('freighter')
    })
  })
})

describe('WalletKitAdapter', () => {
  let adapter: WalletKitAdapter

  describe('initialization', () => {
    it('should initialize with walletId', () => {
      adapter = new WalletKitAdapter('rabet', 'testnet')
      expect(adapter.walletId).toBe('rabet')
    })
  })

  describe('walletId', () => {
    it('should have walletId as "rabet"', () => {
      adapter = new WalletKitAdapter('rabet', 'testnet')
      expect(adapter.walletId).toBe('rabet')
    })

    it('should have walletId as "xbull"', () => {
      adapter = new WalletKitAdapter('xbull', 'testnet')
      expect(adapter.walletId).toBe('xbull')
    })
  })

  describe('connect', () => {
    it('should throw WalletNotConnectedError with not implemented message', async () => {
      adapter = new WalletKitAdapter('rabet', 'testnet')

      await expect(adapter.connect()).rejects.toThrow(WalletNotConnectedError)
      await expect(adapter.connect()).rejects.toThrow('rabet is not yet supported')
    })
  })

  describe('sign', () => {
    it('should throw WalletSigningError with not implemented message', async () => {
      adapter = new WalletKitAdapter('rabet', 'testnet')

      await expect(adapter.sign('test-xdr', 'testnet')).rejects.toThrow(WalletSigningError)
      await expect(adapter.sign('test-xdr', 'testnet')).rejects.toThrow('rabet is not yet supported')
    })
  })

  describe('getNetwork', () => {
    it('should return the network passed in constructor', async () => {
      adapter = new WalletKitAdapter('rabet', 'testnet')
      const network = await adapter.getNetwork()
      expect(network).toBe('testnet')
    })
  })
})
