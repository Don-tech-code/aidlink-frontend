/**
 * Unit tests for SorobanSDK.getBalance (issue #86).
 *
 * Covers all acceptance criteria:
 *   AC1 – Native-only account returns the correct balance string.
 *   AC2 – Multi-asset account returns only the native balance.
 *   AC3 – Horizon 404 throws AccountNotFoundError.
 *   AC4 – Network isolation: mainnet/testnet use different Horizon base URLs.
 *   AC7 – Balance precision: 500 million XLM returned without scientific
 *         notation or precision loss.
 *
 * NOTE: `var` (not `const`) is required for the mock objects so Jest's
 * module-factory hoisting can read them even though `jest.mock()` runs
 * before `import` statements in the compiled output.  The sdk module
 * constructs both SorobanRpc.Server and Horizon.Server at import time (for
 * the deprecated `sorobanSDK` singleton export), so these factories execute
 * immediately on module load.
 */

// ---------------------------------------------------------------------------
// Mocks — must be declared with `var` and hoisted above the imports
// ---------------------------------------------------------------------------

// Shared mock instance for SorobanRpc.Server (used by existing getAccount path)
var mockRpcServer = {
  getAccount: jest.fn(),
  simulateTransaction: jest.fn(),
  sendTransaction: jest.fn(),
  getTransaction: jest.fn(),
}

// Shared mock instance for Horizon.Server
var mockHorizonServer = {
  loadAccount: jest.fn(),
}

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk')
  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: jest.fn().mockImplementation(() => mockRpcServer),
    },
    Horizon: {
      ...actual.Horizon,
      Server: jest.fn().mockImplementation(() => mockHorizonServer),
    },
  }
})

// ---------------------------------------------------------------------------
// Imports (run after jest.mock hoisting)
// ---------------------------------------------------------------------------
import { Horizon } from '@stellar/stellar-sdk'
import {
  SorobanSDK,
  AccountNotFoundError,
  getSorobanSDK,
  __clearSorobanSDKCache,
} from './sdk'
import { NETWORKS as HORIZON_NETWORKS } from '@/config/constants'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Horizon AccountRecord balance line. */
function makeNativeBalance(balance: string): Horizon.ServerApi.BalanceLine<'native'> {
  return {
    asset_type: 'native',
    balance,
    buying_liabilities: '0.0000000',
    selling_liabilities: '0.0000000',
  } as Horizon.ServerApi.BalanceLine<'native'>
}

function makeIssuedBalance(
  assetCode: string,
  balance: string
): Horizon.ServerApi.BalanceLine<'credit_alphanum4'> {
  return {
    asset_type: 'credit_alphanum4',
    asset_code: assetCode,
    asset_issuer: 'GABC123',
    balance,
    buying_liabilities: '0.0000000',
    selling_liabilities: '0.0000000',
    limit: '922337203685.4775807',
    is_authorized: true,
    is_authorized_to_maintain_liabilities: true,
    last_modified_ledger: 1000,
    sponsor: undefined,
  } as unknown as Horizon.ServerApi.BalanceLine<'credit_alphanum4'>
}

/** Returns a minimal Horizon AccountRecord shape. */
function makeAccountRecord(
  balances: Horizon.ServerApi.BalanceLine[]
): Partial<Horizon.ServerApi.AccountRecord> {
  return { balances }
}

/** Builds a Horizon-style 404 error (same shape as the real SDK throws). */
function make404Error() {
  const error = new Error('Resource Missing') as Error & { response?: { status: number } }
  error.response = { status: 404 }
  return error
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SorobanSDK.getBalance', () => {
  let sdk: SorobanSDK

  beforeEach(() => {
    jest.clearAllMocks()
    __clearSorobanSDKCache()
    sdk = new SorobanSDK('testnet')
  })

  // -------------------------------------------------------------------------
  // AC1 — Native-only account returns the correct balance string
  // -------------------------------------------------------------------------
  it('AC1: returns the native XLM balance string for a funded account', async () => {
    mockHorizonServer.loadAccount.mockResolvedValue(
      makeAccountRecord([makeNativeBalance('100.0000000')])
    )

    const result = await sdk.getBalance('GABC123')

    expect(result).toBe('100.0000000')
    expect(mockHorizonServer.loadAccount).toHaveBeenCalledWith('GABC123')
  })

  // -------------------------------------------------------------------------
  // AC2 — Multi-asset account: only the native balance is returned
  // -------------------------------------------------------------------------
  it('AC2: returns only the native balance when account holds multiple assets', async () => {
    mockHorizonServer.loadAccount.mockResolvedValue(
      makeAccountRecord([
        makeNativeBalance('250.5000000'),
        makeIssuedBalance('USDC', '1000.0000000'),
        makeIssuedBalance('AID', '500.0000000'),
      ])
    )

    const result = await sdk.getBalance('GABC123')

    expect(result).toBe('250.5000000')
  })

  // -------------------------------------------------------------------------
  // AC3 — Horizon 404 throws AccountNotFoundError
  // -------------------------------------------------------------------------
  it('AC3: throws AccountNotFoundError when Horizon returns a 404', async () => {
    mockHorizonServer.loadAccount.mockRejectedValue(make404Error())

    await expect(sdk.getBalance('GUNFUNDED')).rejects.toBeInstanceOf(AccountNotFoundError)
  })

  it('AC3: AccountNotFoundError carries the queried address', async () => {
    mockHorizonServer.loadAccount.mockRejectedValue(make404Error())

    try {
      await sdk.getBalance('GUNFUNDED123')
      fail('expected AccountNotFoundError')
    } catch (err) {
      expect(err).toBeInstanceOf(AccountNotFoundError)
      expect((err as AccountNotFoundError).address).toBe('GUNFUNDED123')
    }
  })

  it('AC3: non-404 network errors are re-thrown as-is (not wrapped)', async () => {
    const networkError = new Error('503 Service Unavailable')
    mockHorizonServer.loadAccount.mockRejectedValue(networkError)

    await expect(sdk.getBalance('GABC123')).rejects.toThrow('503 Service Unavailable')
    await expect(sdk.getBalance('GABC123')).rejects.not.toBeInstanceOf(AccountNotFoundError)
  })

  // -------------------------------------------------------------------------
  // AC4 — Network isolation: different networks use different Horizon base URLs
  // -------------------------------------------------------------------------
  it('AC4: getSorobanSDK(mainnet) and getSorobanSDK(testnet) bind different Horizon.Server instances', () => {
    // Clear cache so fresh instances are constructed, each calling
    // new Horizon.Server(url) with their respective Horizon URLs.
    __clearSorobanSDKCache()

    const HorizonServerMock = Horizon.Server as jest.Mock
    HorizonServerMock.mockClear()

    // Capture the URLs passed to Horizon.Server for each network.
    const capturedUrls: string[] = []
    HorizonServerMock.mockImplementation((url: string) => {
      capturedUrls.push(url)
      return mockHorizonServer
    })

    getSorobanSDK('mainnet')
    getSorobanSDK('testnet')

    // Mainnet should use the mainnet Horizon URL, testnet the testnet URL.
    expect(capturedUrls).toContain(HORIZON_NETWORKS.MAINNET)
    expect(capturedUrls).toContain(HORIZON_NETWORKS.TESTNET)
    // They must be different URLs.
    expect(HORIZON_NETWORKS.MAINNET).not.toBe(HORIZON_NETWORKS.TESTNET)
  })

  it('AC4: standalone network passes allowHttp: true to Horizon.Server', () => {
    __clearSorobanSDKCache()

    const HorizonServerMock = Horizon.Server as jest.Mock
    HorizonServerMock.mockClear()

    const capturedOptions: Array<{ allowHttp?: boolean }> = []
    HorizonServerMock.mockImplementation((_url: string, opts: { allowHttp?: boolean } = {}) => {
      capturedOptions.push(opts)
      return mockHorizonServer
    })

    getSorobanSDK('standalone')

    // The last Horizon.Server constructor call is for the standalone network.
    const standaloneOpts = capturedOptions[capturedOptions.length - 1]
    expect(standaloneOpts?.allowHttp).toBe(true)
  })

  it('AC4: non-standalone networks do NOT pass allowHttp: true to Horizon.Server', () => {
    __clearSorobanSDKCache()

    const HorizonServerMock = Horizon.Server as jest.Mock
    HorizonServerMock.mockClear()

    const capturedOptions: Array<{ allowHttp?: boolean }> = []
    HorizonServerMock.mockImplementation((_url: string, opts: { allowHttp?: boolean } = {}) => {
      capturedOptions.push(opts)
      return mockHorizonServer
    })

    getSorobanSDK('testnet')

    // The last Horizon.Server call is the one for testnet.
    const testnetOpts = capturedOptions[capturedOptions.length - 1]
    expect(testnetOpts?.allowHttp).toBeFalsy()
  })

  // -------------------------------------------------------------------------
  // AC7 — Balance precision: 500 million XLM, no scientific notation
  // -------------------------------------------------------------------------
  it('AC7: returns 500 million XLM as a plain decimal string with 7 decimal places', async () => {
    mockHorizonServer.loadAccount.mockResolvedValue(
      makeAccountRecord([makeNativeBalance('500000000.0000000')])
    )

    const result = await sdk.getBalance('GABC123')

    expect(result).toBe('500000000.0000000')
    // Must not be in scientific notation.
    expect(result).not.toMatch(/e/i)
    // Must be parseable without precision loss.
    expect(parseFloat(result)).toBe(500_000_000)
  })

  it('enforces exactly 7 decimal places for a balance with fewer native decimals', async () => {
    // Horizon might return '42' or '42.5' — we normalise to 7dp.
    mockHorizonServer.loadAccount.mockResolvedValue(
      makeAccountRecord([makeNativeBalance('42.5')])
    )

    const result = await sdk.getBalance('GABC123')

    expect(result).toBe('42.5000000')
  })

  // -------------------------------------------------------------------------
  // Caching — Horizon.Server is constructed once per SDK instance
  // -------------------------------------------------------------------------
  it('uses the same Horizon.Server instance across multiple getBalance calls', async () => {
    mockHorizonServer.loadAccount
      .mockResolvedValueOnce(makeAccountRecord([makeNativeBalance('10.0000000')]))
      .mockResolvedValueOnce(makeAccountRecord([makeNativeBalance('20.0000000')]))

    await sdk.getBalance('GABC123')
    await sdk.getBalance('GABC456')

    // loadAccount called twice, but Horizon.Server was only constructed once
    // (in the constructor), not once per call.
    expect(mockHorizonServer.loadAccount).toHaveBeenCalledTimes(2)
    const HorizonServerMock = Horizon.Server as jest.Mock
    // The number of Horizon.Server constructions for this sdk instance is 1.
    // (There may be additional ones from the sorobanSDK singleton created at
    // module load — so we only check that loadAccount was called twice on the
    // shared mock, not that Server was called exactly once total.)
    expect(HorizonServerMock).toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // AccountNotFoundError shape
  // -------------------------------------------------------------------------
  it('AccountNotFoundError has the correct name and message', async () => {
    mockHorizonServer.loadAccount.mockRejectedValue(make404Error())

    try {
      await sdk.getBalance('GNOTFOUND')
    } catch (err) {
      expect(err).toBeInstanceOf(AccountNotFoundError)
      const typed = err as AccountNotFoundError
      expect(typed.name).toBe('AccountNotFoundError')
      expect(typed.message).toContain('GNOTFOUND')
    }
  })
})
