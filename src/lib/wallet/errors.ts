export class WalletNotConnectedError extends Error {
  readonly code = 'WALLET_NOT_CONNECTED'

  constructor(message: string = 'Wallet is not connected') {
    super(message)
    this.name = 'WalletNotConnectedError'
  }
}

export class WalletSigningError extends Error {
  readonly code = 'WALLET_SIGNING_ERROR'

  constructor(message: string = 'Failed to sign transaction', public readonly cause?: unknown) {
    super(message)
    this.name = 'WalletSigningError'
  }
}

export class NoActiveWalletError extends Error {
  readonly code = 'NO_ACTIVE_WALLET'

  constructor(message: string = 'No active wallet connection') {
    super(message)
    this.name = 'NoActiveWalletError'
  }
}
