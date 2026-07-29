// `var` (not `const`) so this is safely readable by the jest.mock() factory
// below via closure even though jest's hoisting runs `jest.mock` (and the
// factory, at module-load time) above this declaration in the compiled
// output — sdk.ts constructs a SorobanRpc.Server at import time for its
// deprecated `sorobanSDK` singleton export, so the factory runs immediately.
var mockServer = {
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
      Server: jest.fn().mockImplementation(() => mockServer),
    },
  }
})

import { Keypair, Account, SorobanDataBuilder, xdr, Address } from '@stellar/stellar-sdk'
import { SorobanSDK, SorobanContractError, SorobanTimeoutError } from './sdk'

const TEST_CONTRACT_ID = Address.contract(Buffer.alloc(32, 1)).toString()

function freshAccount(): Account {
  return new Account(Keypair.random().publicKey(), '100')
}

function successSimulation(overrides: Record<string, unknown> = {}) {
  return {
    id: '1',
    latestLedger: 100,
    events: [],
    _parsed: true,
    transactionData: new SorobanDataBuilder(),
    minResourceFee: '100',
    cost: { cpuInsns: '0', memBytes: '0' },
    result: { retval: xdr.ScVal.scvVoid(), auth: [] },
    ...overrides,
  }
}

describe('SorobanSDK.invokeContract (issue #85)', () => {
  let sdk: SorobanSDK
  const signer = jest.fn(async (xdrEnvelope: string) => xdrEnvelope)

  beforeEach(() => {
    jest.clearAllMocks()
    sdk = new SorobanSDK('testnet', { pollIntervalMs: 10, pollTimeoutMs: 50 })
    mockServer.getAccount.mockResolvedValue(freshAccount())
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('awaits a second poll and resolves with the return value after a PENDING then SUCCESS response', async () => {
    mockServer.simulateTransaction.mockResolvedValue(successSimulation())
    mockServer.sendTransaction.mockResolvedValue({
      status: 'PENDING',
      hash: 'tx-hash-1',
      latestLedger: 1,
      latestLedgerCloseTime: 1,
    })

    const returnValue = xdr.ScVal.scvU32(42)
    mockServer.getTransaction
      .mockResolvedValueOnce({ status: 'PENDING' })
      .mockResolvedValueOnce({ status: 'SUCCESS', returnValue })

    const result = await sdk.invokeContract({
      contractId: TEST_CONTRACT_ID,
      method: 'ping',
      sourcePublicKey: Keypair.random().publicKey(),
      signer,
    })

    expect(mockServer.getTransaction).toHaveBeenCalledTimes(2)
    expect(result.status).toBe('SUCCESS')
    expect(result.returnValue).toBe(returnValue)
  })

  it('rejects with a SorobanContractError carrying resultXdr on a FAILED response', async () => {
    mockServer.simulateTransaction.mockResolvedValue(successSimulation())
    mockServer.sendTransaction.mockResolvedValue({
      status: 'PENDING',
      hash: 'tx-hash-2',
      latestLedger: 1,
      latestLedgerCloseTime: 1,
    })
    mockServer.getTransaction.mockResolvedValue({ status: 'FAILED', resultXdr: 'AAAAAAAAAGT/////' })

    const invocation = sdk.invokeContract({
      contractId: TEST_CONTRACT_ID,
      method: 'ping',
      sourcePublicKey: Keypair.random().publicKey(),
      signer,
    })

    await expect(invocation).rejects.toBeInstanceOf(SorobanContractError)
    await expect(invocation).rejects.toMatchObject({ resultXdr: 'AAAAAAAAAGT/////' })
  })

  it('rejects with SorobanTimeoutError once pollTimeoutMs elapses without a terminal status', async () => {
    jest.useFakeTimers()

    mockServer.simulateTransaction.mockResolvedValue(successSimulation())
    mockServer.sendTransaction.mockResolvedValue({
      status: 'PENDING',
      hash: 'tx-hash-3',
      latestLedger: 1,
      latestLedgerCloseTime: 1,
    })
    mockServer.getTransaction.mockResolvedValue({ status: 'PENDING' })

    const invocation = sdk.invokeContract({
      contractId: TEST_CONTRACT_ID,
      method: 'ping',
      sourcePublicKey: Keypair.random().publicKey(),
      signer,
    })
    const assertion = expect(invocation).rejects.toBeInstanceOf(SorobanTimeoutError)

    const advanceTimersByTimeAsync = (jest as unknown as { advanceTimersByTimeAsync: (ms: number) => Promise<void> })
      .advanceTimersByTimeAsync
    await advanceTimersByTimeAsync(1000)

    await assertion
  })

  it('issues exactly one restore transaction before the original invocation when simulation returns a restorePreamble', async () => {
    mockServer.simulateTransaction
      .mockResolvedValueOnce(
        successSimulation({
          restorePreamble: { minResourceFee: '50', transactionData: new SorobanDataBuilder() },
        })
      )
      .mockResolvedValueOnce(successSimulation())

    mockServer.sendTransaction
      .mockResolvedValueOnce({ status: 'PENDING', hash: 'restore-hash', latestLedger: 1, latestLedgerCloseTime: 1 })
      .mockResolvedValueOnce({ status: 'PENDING', hash: 'invoke-hash', latestLedger: 1, latestLedgerCloseTime: 1 })

    mockServer.getTransaction
      .mockResolvedValueOnce({ status: 'SUCCESS' }) // restore finalizes
      .mockResolvedValueOnce({ status: 'SUCCESS', returnValue: xdr.ScVal.scvVoid() }) // invocation finalizes

    const result = await sdk.invokeContract({
      contractId: TEST_CONTRACT_ID,
      method: 'ping',
      sourcePublicKey: Keypair.random().publicKey(),
      signer,
    })

    expect(mockServer.sendTransaction).toHaveBeenCalledTimes(2)
    expect(result.txHash).toBe('invoke-hash')
  })
})
