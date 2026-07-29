import { WalletNotConnectedError, WalletSigningError, NoActiveWalletError } from '../errors'

describe('Wallet Errors', () => {
  describe('WalletNotConnectedError', () => {
    it('should extend Error', () => {
      const error = new WalletNotConnectedError()
      expect(error).toBeInstanceOf(Error)
    })

    it('should have code field', () => {
      const error = new WalletNotConnectedError()
      expect(error.code).toBe('WALLET_NOT_CONNECTED')
    })

    it('should have correct name', () => {
      const error = new WalletNotConnectedError()
      expect(error.name).toBe('WalletNotConnectedError')
    })

    it('should use default message', () => {
      const error = new WalletNotConnectedError()
      expect(error.message).toBe('Wallet is not connected')
    })

    it('should accept custom message', () => {
      const error = new WalletNotConnectedError('Custom message')
      expect(error.message).toBe('Custom message')
    })
  })

  describe('WalletSigningError', () => {
    it('should extend Error', () => {
      const error = new WalletSigningError()
      expect(error).toBeInstanceOf(Error)
    })

    it('should have code field', () => {
      const error = new WalletSigningError()
      expect(error.code).toBe('WALLET_SIGNING_ERROR')
    })

    it('should have correct name', () => {
      const error = new WalletSigningError()
      expect(error.name).toBe('WalletSigningError')
    })

    it('should use default message', () => {
      const error = new WalletSigningError()
      expect(error.message).toBe('Failed to sign transaction')
    })

    it('should accept custom message', () => {
      const error = new WalletSigningError('Custom signing error')
      expect(error.message).toBe('Custom signing error')
    })

    it('should store cause', () => {
      const cause = new Error('Original error')
      const error = new WalletSigningError('Custom message', cause)
      expect(error.cause).toBe(cause)
    })
  })

  describe('NoActiveWalletError', () => {
    it('should extend Error', () => {
      const error = new NoActiveWalletError()
      expect(error).toBeInstanceOf(Error)
    })

    it('should have code field', () => {
      const error = new NoActiveWalletError()
      expect(error.code).toBe('NO_ACTIVE_WALLET')
    })

    it('should have correct name', () => {
      const error = new NoActiveWalletError()
      expect(error.name).toBe('NoActiveWalletError')
    })

    it('should use default message', () => {
      const error = new NoActiveWalletError()
      expect(error.message).toBe('No active wallet connection')
    })

    it('should accept custom message', () => {
      const error = new NoActiveWalletError('Custom no wallet message')
      expect(error.message).toBe('Custom no wallet message')
    })
  })
})
