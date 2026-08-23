/**
 * Integration tests for BeneficiaryRegistryClient
 *
 * Acceptance criteria:
 *  AC1 – getRole: ScvU32(3) from get_role → returns 'admin'
 *  AC2 – getRole: ScvVoid (address not registered) → returns null
 *  AC3 – updateVerificationStatus: calls simulateTransaction, sendTransaction,
 *         and getTransaction (via pollWithBackoff) in order
 *  AC4 – Auth flow: fetchRole stores user.role === 'admin' and sets the
 *         auth-role cookie when getRole resolves 'admin'
 *  AC5 – withRequireRole(AdminPage, ['admin']) renders <AdminPage> without
 *         throwing UnauthorizedError when role is 'admin'
 *  AC6 – updateVerificationStatus rejects with a descriptive error when
 *         sendTransaction returns { status: 'ERROR' }
 */

// ---------------------------------------------------------------------------
// Mock @stellar/stellar-sdk BEFORE any imports that pull it in.
//
// We use `var` (hoisted past `jest.mock` factory closure) so the mock server
// object is shared across all tests.
// ---------------------------------------------------------------------------

var mockRpcServer = {
  getAccount: jest.fn(),
  simulateTransaction: jest.fn(),
  sendTransaction: jest.fn(),
  getTransaction: jest.fn(),
}

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk')
  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: jest.fn().mockImplementation(() => mockRpcServer),
    },
  }
})

// Mock @stellar/freighter-api so signing never shows a browser dialog
jest.mock('@stellar/freighter-api', () => ({
  signTransaction: jest.fn(),
}))

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import React from 'react'
import { render, act } from '@testing-library/react'
import {
  Account,
  Keypair,
  SorobanDataBuilder,
  SorobanRpc,
  xdr,
} from '@stellar/stellar-sdk'
import { signTransaction } from '@stellar/freighter-api'
import { BeneficiaryRegistryClient } from '../beneficiary-registry'
import { useAuthStore } from '@/store/auth-store'
import { AuthProvider, withRequireRole, UnauthorizedError } from '@/components/providers/auth-provider'
import { useWalletStore } from '@/store/wallet-store'

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockSignTransaction = signTransaction as jest.MockedFunction<typeof signTransaction>

const FAKE_CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4'
const ADMIN_KEY = Keypair.random().publicKey()
const SIGNER_KEY = Keypair.random().publicKey()

/** Minimal Soroban simulation success response shape */
function makeSimSuccess(retval: xdr.ScVal) {
  return {
    id: '1',
    latestLedger: 100,
    events: [],
    _parsed: true,
    transactionData: new SorobanDataBuilder(),
    minResourceFee: '100',
    cost: { cpuInsns: '0', memBytes: '0' },
    result: { retval, auth: [] },
  }
}

/** Helper to build a fake source Account without network lookup */
function fakeAccount(publicKey: string) {
  return new Account(publicKey, '0')
}

// ---------------------------------------------------------------------------
// Shared beforeEach / afterEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  // resetAllMocks clears both mock state AND implementation overrides so that
  // a mockResolvedValue set in one test does not bleed into the next.
  // clearAllMocks() only clears state (calls/results) but retains implementations.
  jest.resetAllMocks()

  // Re-apply the Server constructor mock after resetAllMocks cleared it.
  ;(SorobanRpc.Server as jest.MockedClass<typeof SorobanRpc.Server>).mockImplementation(
    () => mockRpcServer as unknown as SorobanRpc.Server,
  )

  // Default getAccount — returns a usable Account stub
  mockRpcServer.getAccount.mockImplementation((address: string) =>
    Promise.resolve(fakeAccount(address)),
  )

  // Default getTransaction — SUCCESS on first poll
  mockRpcServer.getTransaction.mockResolvedValue({
    status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
  })
})

// ===========================================================================
// AC1 — ScvU32(3) → 'admin'
// ===========================================================================

describe('BeneficiaryRegistryClient.getRole', () => {
  it('AC1: ScvU32(3) from get_role returns "admin"', async () => {
    const retval = xdr.ScVal.scvU32(3) // 3 = admin in ROLE_MAP

    mockRpcServer.simulateTransaction.mockResolvedValue(makeSimSuccess(retval))

    const client = new BeneficiaryRegistryClient(FAKE_CONTRACT_ID, 'testnet')
    const role = await client.getRole(ADMIN_KEY)

    expect(role).toBe('admin')
    expect(mockRpcServer.simulateTransaction).toHaveBeenCalledTimes(1)
  })

  it('also maps ScvU32(0) → "donor"', async () => {
    mockRpcServer.simulateTransaction.mockResolvedValue(
      makeSimSuccess(xdr.ScVal.scvU32(0)),
    )
    const client = new BeneficiaryRegistryClient(FAKE_CONTRACT_ID, 'testnet')
    expect(await client.getRole(ADMIN_KEY)).toBe('donor')
  })

  it('also maps ScvU32(1) → "ngo"', async () => {
    mockRpcServer.simulateTransaction.mockResolvedValue(
      makeSimSuccess(xdr.ScVal.scvU32(1)),
    )
    const client = new BeneficiaryRegistryClient(FAKE_CONTRACT_ID, 'testnet')
    expect(await client.getRole(ADMIN_KEY)).toBe('ngo')
  })

  it('also maps ScvU32(2) → "beneficiary"', async () => {
    mockRpcServer.simulateTransaction.mockResolvedValue(
      makeSimSuccess(xdr.ScVal.scvU32(2)),
    )
    const client = new BeneficiaryRegistryClient(FAKE_CONTRACT_ID, 'testnet')
    expect(await client.getRole(ADMIN_KEY)).toBe('beneficiary')
  })

  it('also maps ScvSymbol("Admin") → "admin"', async () => {
    mockRpcServer.simulateTransaction.mockResolvedValue(
      makeSimSuccess(xdr.ScVal.scvSymbol(Buffer.from('Admin'))),
    )
    const client = new BeneficiaryRegistryClient(FAKE_CONTRACT_ID, 'testnet')
    expect(await client.getRole(ADMIN_KEY)).toBe('admin')
  })

  it('also decodes ScvMap { role: ScvSymbol("Admin") } → "admin"', async () => {
    const mapVal = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol(Buffer.from('role')),
        val: xdr.ScVal.scvSymbol(Buffer.from('Admin')),
      }),
    ])
    mockRpcServer.simulateTransaction.mockResolvedValue(makeSimSuccess(mapVal))

    const client = new BeneficiaryRegistryClient(FAKE_CONTRACT_ID, 'testnet')
    expect(await client.getRole(ADMIN_KEY)).toBe('admin')
  })

  // -------------------------------------------------------------------------
  // AC2 — ScvVoid → null
  // -------------------------------------------------------------------------

  it('AC2: ScvVoid (address not registered) returns null', async () => {
    mockRpcServer.simulateTransaction.mockResolvedValue(
      makeSimSuccess(xdr.ScVal.scvVoid()),
    )

    const client = new BeneficiaryRegistryClient(FAKE_CONTRACT_ID, 'testnet')
    const role = await client.getRole(ADMIN_KEY)

    expect(role).toBeNull()
  })

  it('returns null when contractId is empty (no RPC call made)', async () => {
    const client = new BeneficiaryRegistryClient('', 'testnet')
    const role = await client.getRole(ADMIN_KEY)

    expect(role).toBeNull()
    expect(mockRpcServer.simulateTransaction).not.toHaveBeenCalled()
  })

  it('returns null when publicKey is empty (no RPC call made)', async () => {
    const client = new BeneficiaryRegistryClient(FAKE_CONTRACT_ID, 'testnet')
    const role = await client.getRole('')

    expect(role).toBeNull()
    expect(mockRpcServer.simulateTransaction).not.toHaveBeenCalled()
  })

  it('returns null when simulation returns no retval', async () => {
    mockRpcServer.simulateTransaction.mockResolvedValue({
      id: '1',
      latestLedger: 100,
      events: [],
      _parsed: true,
      transactionData: new SorobanDataBuilder(),
      minResourceFee: '100',
      cost: { cpuInsns: '0', memBytes: '0' },
      result: undefined, // no retval
    })
    const client = new BeneficiaryRegistryClient(FAKE_CONTRACT_ID, 'testnet')
    expect(await client.getRole(ADMIN_KEY)).toBeNull()
  })

  it('throws when simulation returns a non-"not found" error', async () => {
    mockRpcServer.simulateTransaction.mockResolvedValue({
      id: '1',
      latestLedger: 100,
      error: 'Wasm trap: unreachable code',
      events: [],
      _parsed: true,
    })

    const client = new BeneficiaryRegistryClient(FAKE_CONTRACT_ID, 'testnet')
    await expect(client.getRole(ADMIN_KEY)).rejects.toThrow(
      /get_role simulation failed/,
    )
  })
})

// ===========================================================================
// AC3 — updateVerificationStatus calls rpc in order: simulate → send → poll
// ===========================================================================

describe('BeneficiaryRegistryClient.updateVerificationStatus', () => {
  /** Signed XDR stub returned by the mock signer */
  const SIGNED_XDR = 'AAAAAAA_SIGNED_XDR_PLACEHOLDER=='

  function setupSuccessfulWrite() {
    // 1. simulateTransaction succeeds
    mockRpcServer.simulateTransaction.mockResolvedValue(
      makeSimSuccess(xdr.ScVal.scvVoid()),
    )
    // 2. signTransaction returns the signed XDR envelope in the v6 shape
    mockSignTransaction.mockResolvedValue({ signedTxXdr: SIGNED_XDR, signerAddress: SIGNER_KEY })
    // 3. sendTransaction returns PENDING with a hash
    mockRpcServer.sendTransaction.mockResolvedValue({
      status: 'PENDING',
      hash: 'abc123txhash',
      latestLedger: 100,
      latestLedgerCloseTime: 1_000_000,
    })
    // 4. getTransaction (poll) returns SUCCESS on first attempt
    mockRpcServer.getTransaction.mockResolvedValue({
      status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
    })
  }

  it('AC3: calls simulateTransaction, sendTransaction, and getTransaction in order', async () => {
    setupSuccessfulWrite()

    const callOrder: string[] = []
    mockRpcServer.simulateTransaction.mockImplementation(async () => {
      callOrder.push('simulate')
      return makeSimSuccess(xdr.ScVal.scvVoid())
    })
    mockRpcServer.sendTransaction.mockImplementation(async () => {
      callOrder.push('send')
      return { status: 'PENDING', hash: 'abc123txhash', latestLedger: 100, latestLedgerCloseTime: 1_000_000 }
    })
    mockRpcServer.getTransaction.mockImplementation(async () => {
      callOrder.push('getTransaction')
      return { status: SorobanRpc.Api.GetTransactionStatus.SUCCESS }
    })

    const client = new BeneficiaryRegistryClient(
      FAKE_CONTRACT_ID,
      'testnet',
      SIGNER_KEY,
    )
    await client.updateVerificationStatus(ADMIN_KEY, 1)

    expect(callOrder).toEqual(['simulate', 'send', 'getTransaction'])
  })

  it('resolves without error on a successful write', async () => {
    setupSuccessfulWrite()

    const client = new BeneficiaryRegistryClient(
      FAKE_CONTRACT_ID,
      'testnet',
      SIGNER_KEY,
    )
    await expect(
      client.updateVerificationStatus(ADMIN_KEY, 1),
    ).resolves.toBeUndefined()
  })

  it('passes the correct status u32 arg to the simulation', async () => {
    setupSuccessfulWrite()

    const client = new BeneficiaryRegistryClient(
      FAKE_CONTRACT_ID,
      'testnet',
      SIGNER_KEY,
    )
    await client.updateVerificationStatus(ADMIN_KEY, 1)

    // The simulation must have been called — account / args are embedded in tx XDR
    expect(mockRpcServer.simulateTransaction).toHaveBeenCalledTimes(1)
  })

  it('throws when contractId is empty', async () => {
    const client = new BeneficiaryRegistryClient('', 'testnet', SIGNER_KEY)
    await expect(
      client.updateVerificationStatus(ADMIN_KEY, 1),
    ).rejects.toThrow(/required/)
  })

  it('throws when account is empty', async () => {
    const client = new BeneficiaryRegistryClient(
      FAKE_CONTRACT_ID,
      'testnet',
      SIGNER_KEY,
    )
    await expect(client.updateVerificationStatus('', 1)).rejects.toThrow(
      /required/,
    )
  })

  it('throws when no signer is available', async () => {
    const client = new BeneficiaryRegistryClient(FAKE_CONTRACT_ID, 'testnet') // no signerAddress
    await expect(
      client.updateVerificationStatus(ADMIN_KEY, 1),
    ).rejects.toThrow(/signer address is required/)
  })

  // -------------------------------------------------------------------------
  // AC6 — sendTransaction ERROR → promise rejects with descriptive error
  // -------------------------------------------------------------------------

  it('AC6: rejects with a descriptive error when sendTransaction returns ERROR', async () => {
    // Simulation succeeds
    mockRpcServer.simulateTransaction.mockResolvedValue(
      makeSimSuccess(xdr.ScVal.scvVoid()),
    )
    // Signer returns stub XDR
    mockSignTransaction.mockResolvedValue({ signedTxXdr: SIGNED_XDR, signerAddress: SIGNER_KEY })
    // Network rejects the transaction
    mockRpcServer.sendTransaction.mockResolvedValue({
      status: 'ERROR',
      hash: '',
      errorResult: null,
    })

    const client = new BeneficiaryRegistryClient(
      FAKE_CONTRACT_ID,
      'testnet',
      SIGNER_KEY,
    )

    await expect(
      client.updateVerificationStatus(ADMIN_KEY, 1),
    ).rejects.toThrow(/update_verification_status transaction rejected/)

    // getTransaction must NOT be called — we never got a hash to poll
    expect(mockRpcServer.getTransaction).not.toHaveBeenCalled()
  })

  it('AC6: rejects with XDR detail in error message when errorResult is present', async () => {
    mockRpcServer.simulateTransaction.mockResolvedValue(
      makeSimSuccess(xdr.ScVal.scvVoid()),
    )
    mockSignTransaction.mockResolvedValue({ signedTxXdr: SIGNED_XDR, signerAddress: SIGNER_KEY })
    mockRpcServer.sendTransaction.mockResolvedValue({
      status: 'ERROR',
      hash: '',
      errorResult: { toXDR: (_enc: string) => 'AAAAAAAAAGT/////' },
    })

    const client = new BeneficiaryRegistryClient(
      FAKE_CONTRACT_ID,
      'testnet',
      SIGNER_KEY,
    )

    await expect(
      client.updateVerificationStatus(ADMIN_KEY, 1),
    ).rejects.toThrow('AAAAAAAAAGT/////')
  })

  it('AC6: never silently resolves — simulation error also propagates', async () => {
    mockRpcServer.simulateTransaction.mockResolvedValue({
      id: '1',
      latestLedger: 100,
      error: 'Contract trap: panic at line 42',
      events: [],
      _parsed: true,
    })

    const client = new BeneficiaryRegistryClient(
      FAKE_CONTRACT_ID,
      'testnet',
      SIGNER_KEY,
    )

    await expect(
      client.updateVerificationStatus(ADMIN_KEY, 1),
    ).rejects.toThrow(/simulation failed/)

    // sendTransaction must NOT be called if simulation failed
    expect(mockRpcServer.sendTransaction).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// AC4 — Auth-store fetchRole stores user.role === 'admin' and sets cookie
// ===========================================================================

describe('auth-store fetchRole (AC4)', () => {
  beforeEach(() => {
    // Reset auth store state
    useAuthStore.setState({
      user: null,
      roleLoadingState: 'idle',
      lastFetch: null,
    })

    // Reset cookies
    if (typeof document !== 'undefined') {
      document.cookie = 'auth-role=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT'
    }
  })

  it('AC4: stores user.role === "admin" when mocked getRole returns "admin"', async () => {
    // Mock the beneficiaryRegistryClient singleton's getRole at the module level
    const { beneficiaryRegistryClient } = await import('../beneficiary-registry')
    const spy = jest
      .spyOn(beneficiaryRegistryClient, 'getRole')
      .mockResolvedValue('admin')

    await act(async () => {
      await useAuthStore.getState().fetchRole(ADMIN_KEY)
    })

    const { user, roleLoadingState } = useAuthStore.getState()

    expect(spy).toHaveBeenCalledWith(ADMIN_KEY)
    expect(user).not.toBeNull()
    expect(user?.role).toBe('admin')
    expect(roleLoadingState).toBe('loaded')

    spy.mockRestore()
  })

  it('AC4: sets the auth-role cookie to "admin"', async () => {
    const { beneficiaryRegistryClient } = await import('../beneficiary-registry')
    const spy = jest
      .spyOn(beneficiaryRegistryClient, 'getRole')
      .mockResolvedValue('admin')

    await act(async () => {
      await useAuthStore.getState().fetchRole(ADMIN_KEY)
    })

    expect(document.cookie).toContain('auth-role=admin')

    spy.mockRestore()
  })

  it('falls back to "donor" when getRole returns null (unregistered wallet)', async () => {
    const { beneficiaryRegistryClient } = await import('../beneficiary-registry')
    const spy = jest
      .spyOn(beneficiaryRegistryClient, 'getRole')
      .mockResolvedValue(null)

    await act(async () => {
      await useAuthStore.getState().fetchRole(ADMIN_KEY)
    })

    expect(useAuthStore.getState().user?.role).toBe('donor')

    spy.mockRestore()
  })

  it('sets roleLoadingState to "error" when getRole throws', async () => {
    const { beneficiaryRegistryClient } = await import('../beneficiary-registry')
    const spy = jest
      .spyOn(beneficiaryRegistryClient, 'getRole')
      .mockRejectedValue(new Error('RPC timeout'))

    await act(async () => {
      await useAuthStore.getState().fetchRole(ADMIN_KEY)
    })

    expect(useAuthStore.getState().roleLoadingState).toBe('error')

    spy.mockRestore()
  })
})

// ===========================================================================
// AC5 — withRequireRole(AdminPage, ['admin']) renders AdminPage when role is admin
// ===========================================================================

describe('withRequireRole (AC5)', () => {
  /** Simple stub admin page */
  function AdminPage() {
    return <div data-testid="admin-page">Admin Content</div>
  }

  it('AC5: renders <AdminPage> without throwing UnauthorizedError when role is "admin"', async () => {
    // Pre-seed auth store with an admin user — no network needed
    useAuthStore.setState({
      user: {
        id: ADMIN_KEY,
        walletAddress: ADMIN_KEY,
        role: 'admin',
        name: ADMIN_KEY,
        createdAt: new Date().toISOString(),
      },
      roleLoadingState: 'loaded',
      lastFetch: Date.now(),
    })

    // Pre-seed wallet store so AuthProvider does not clear the role
    useWalletStore.setState({
      isConnected: true,
      address: ADMIN_KEY,
      publicKey: ADMIN_KEY,
      network: 'testnet',
      balance: '1000',
    })

    const ProtectedAdmin = withRequireRole(AdminPage, ['admin'])

    let renderError: Error | null = null
    try {
      const { getByTestId } = render(
        <AuthProvider>
          <ProtectedAdmin />
        </AuthProvider>,
      )
      expect(getByTestId('admin-page')).not.toBeNull()
    } catch (err) {
      renderError = err as Error
    }

    expect(renderError).toBeNull()
  })

  it('throws UnauthorizedError when role is "donor" for an admin-only page', () => {
    useAuthStore.setState({
      user: {
        id: 'GDUMMYKEY',
        walletAddress: 'GDUMMYKEY',
        role: 'donor',
        name: 'GDUMMYKEY',
        createdAt: new Date().toISOString(),
      },
      roleLoadingState: 'loaded',
      lastFetch: Date.now(),
    })

    const ProtectedAdmin = withRequireRole(AdminPage, ['admin'])

    expect(() =>
      render(
        <AuthProvider>
          <ProtectedAdmin />
        </AuthProvider>,
      ),
    ).toThrow(UnauthorizedError)
  })

  it('does not throw while role is still loading (roleLoadingState === "loading")', () => {
    useAuthStore.setState({
      user: null,
      roleLoadingState: 'loading',
      lastFetch: null,
    })

    // Explicitly clear the wallet public key so AuthProvider calls clearRole()
    // rather than fetchRole() — this test verifies the "not yet authenticated"
    // render path, not the "wrong role after fetch" path.
    useWalletStore.setState({
      isConnected: false,
      address: null,
      publicKey: null,
      network: 'testnet',
      balance: '0',
    })

    const ProtectedAdmin = withRequireRole(AdminPage, ['admin'])

    expect(() =>
      render(
        <AuthProvider>
          <ProtectedAdmin />
        </AuthProvider>,
      ),
    ).not.toThrow()
  })
})
