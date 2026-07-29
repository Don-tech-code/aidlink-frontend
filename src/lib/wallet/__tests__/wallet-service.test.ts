import { WalletService } from '../wallet-service'
import { FreighterAdapter, WalletKitAdapter } from '../adapters'
import { NoActiveWalletError } from '../errors'

// Mock the adapters
jest.mock('../adapters')

// Mock the wallet store
jest.mock('@/store/wallet-store', () => ({
  useWalletStore: {
    getState: jest.fn(() => ({
      network: 'testnet',
      switchNetwork: jest.fn(),
    })),
  },
}))

describe('WalletService', () => {
  let walletService: WalletService
  let mockFreighterAdapter: jest.Mocked<FreighterAdapter>
  let mockWalletKitAdapter: jest.Mocked<WalletKitAdapter>

  beforeEach(() => {
    jest.clearAllMocks()
    walletService = new WalletService()

    // Setup adapter mocks
    mockFreighterAdapter = {
      walletId: 'freighter',
      connect: jest.fn(),
      sign: jest.fn(),
      getNetwork: jest.fn(),
      disconnect: jest.fn(),
    } as any

    mockWalletKitAdapter = {
      walletId: 'rabet',
      connect: jest.fn(),
      sign: jest.fn(),
      getNetwork: jest.fn(),
      disconnect: jest.fn(),
    } as any

    ;(FreighterAdapter as jest.MockedClass<typeof FreighterAdapter>).mockImplementation(() => mockFreighterAdapter)
    ;(WalletKitAdapter as jest.MockedClass<typeof WalletKitAdapter>).mockImplementation(() => mockWalletKitAdapter)
  })

  describe('connect', () => {
    it('should connect to Freighter and set it as active adapter', async () => {
      const mockWalletInfo = {
        publicKey: 'GCZJM35NKGVK47BB4SPBDV25477PZYIYPVVG453LPYFNXLS3FGHDXOCM',
        address: 'GCZJM35NKGVK47BB4SPBDV25477PZYIYPVVG453LPYFNXLS3FGHDXOCM',
        network: 'testnet',
      }

      mockFreighterAdapter.connect.mockResolvedValue(mockWalletInfo)

      const result = await walletService.connect('freighter', 'testnet')

      expect(result).toEqual(mockWalletInfo)
      expect(mockFreighterAdapter.connect).toHaveBeenCalled()
      expect(walletService.isConnected()).toBe(true)
      expect(walletService.getActiveWalletId()).toBe('freighter')
    })

    it('should connect to Rabet and set it as active adapter', async () => {
      const mockWalletInfo = {
        publicKey: 'GCZJM35NKGVK47BB4SPBDV25477PZYIYPVVG453LPYFNXLS3FGHDXOCM',
        address: 'GCZJM35NKGVK47BB4SPBDV25477PZYIYPVVG453LPYFNXLS3FGHDXOCM',
        network: 'testnet',
      }

      mockWalletKitAdapter.connect.mockResolvedValue(mockWalletInfo)

      const result = await walletService.connect('rabet', 'testnet')

      expect(result).toEqual(mockWalletInfo)
      expect(WalletKitAdapter).toHaveBeenCalledWith('rabet', 'testnet')
      expect(mockWalletKitAdapter.connect).toHaveBeenCalled()
    })

    it('should replace previous adapter when connecting to a different wallet', async () => {
      const mockFreighterInfo = {
        publicKey: 'GFREIGHTER...',
        address: 'GFREIGHTER...',
        network: 'testnet',
      }

      const mockRabetInfo = {
        publicKey: 'GRABET...',
        address: 'GRABET...',
        network: 'testnet',
      }

      mockFreighterAdapter.connect.mockResolvedValue(mockFreighterInfo)
      mockWalletKitAdapter.connect.mockResolvedValue(mockRabetInfo)
      mockWalletKitAdapter.sign.mockResolvedValue('signed-by-rabet')

      // Connect to Freighter first
      await walletService.connect('freighter', 'testnet')
      expect(walletService.getActiveWalletId()).toBe('freighter')

      // Connect to Rabet second (should replace Freighter)
      await walletService.connect('rabet', 'testnet')
      expect(walletService.getActiveWalletId()).toBe('rabet')

      // Verify sign routes to Rabet, not Freighter
      const signedXdr = await walletService.sign('test-xdr')
      expect(signedXdr).toBe('signed-by-rabet')
      expect(mockWalletKitAdapter.sign).toHaveBeenCalledWith('test-xdr', 'testnet')
      expect(mockFreighterAdapter.sign).not.toHaveBeenCalled()
    })

    it('should cache adapters by wallet-network key', async () => {
      const mockWalletInfo = {
        publicKey: 'G...',
        address: 'G...',
        network: 'testnet',
      }

      mockFreighterAdapter.connect.mockResolvedValue(mockWalletInfo)

      // Connect twice with same wallet and network
      await walletService.connect('freighter', 'testnet')
      await walletService.connect('freighter', 'testnet')

      // FreighterAdapter should only be instantiated once (cached)
      expect(FreighterAdapter).toHaveBeenCalledTimes(1)
    })
  })

  describe('sign', () => {
    it('should throw NoActiveWalletError when no wallet is connected', async () => {
      await expect(walletService.sign('test-xdr')).rejects.toThrow(NoActiveWalletError)
      await expect(walletService.sign('test-xdr')).rejects.toThrow('No wallet is connected')
    })

    it('should delegate to active adapter with current network from WalletStore', async () => {
      const mockWalletInfo = {
        publicKey: 'G...',
        address: 'G...',
        network: 'testnet',
      }

      mockFreighterAdapter.connect.mockResolvedValue(mockWalletInfo)
      mockFreighterAdapter.sign.mockResolvedValue('signed-xdr')

      await walletService.connect('freighter', 'testnet')
      const result = await walletService.sign('test-xdr')

      expect(mockFreighterAdapter.sign).toHaveBeenCalledWith('test-xdr', 'testnet')
      expect(result).toBe('signed-xdr')
    })
  })

  describe('disconnect', () => {
    it('should call adapter disconnect and clear active adapter', async () => {
      const mockWalletInfo = {
        publicKey: 'G...',
        address: 'G...',
        network: 'testnet',
      }

      mockFreighterAdapter.connect.mockResolvedValue(mockWalletInfo)

      await walletService.connect('freighter', 'testnet')
      expect(walletService.isConnected()).toBe(true)

      await walletService.disconnect()

      expect(mockFreighterAdapter.disconnect).toHaveBeenCalled()
      expect(walletService.isConnected()).toBe(false)
      expect(walletService.getActiveWalletId()).toBeNull()
    })

    it('should not throw when no wallet is connected', async () => {
      await expect(walletService.disconnect()).resolves.not.toThrow()
    })
  })

  describe('getCurrentNetwork', () => {
    it('should read network from WalletStore', () => {
      const network = walletService.getCurrentNetwork()
      expect(network).toBe('testnet')
    })
  })

  describe('isConnected', () => {
    it('should return false when no wallet is connected', () => {
      expect(walletService.isConnected()).toBe(false)
    })

    it('should return true after connecting a wallet', async () => {
      const mockWalletInfo = {
        publicKey: 'G...',
        address: 'G...',
        network: 'testnet',
      }

      mockFreighterAdapter.connect.mockResolvedValue(mockWalletInfo)

      await walletService.connect('freighter', 'testnet')
      expect(walletService.isConnected()).toBe(true)
    })
  })

  describe('getActiveWalletId', () => {
    it('should return null when no wallet is connected', () => {
      expect(walletService.getActiveWalletId()).toBeNull()
    })

    it('should return the connected wallet ID', async () => {
      const mockWalletInfo = {
        publicKey: 'G...',
        address: 'G...',
        network: 'testnet',
      }

      mockFreighterAdapter.connect.mockResolvedValue(mockWalletInfo)

      await walletService.connect('freighter', 'testnet')
      expect(walletService.getActiveWalletId()).toBe('freighter')
    })
  })
})
