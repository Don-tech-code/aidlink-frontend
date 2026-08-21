/**
 * Unit tests for the parts of useDonation's fix for issue #139 that operate
 * on real Stellar XDR: decodeResultXdr's operation-level result decoding,
 * generateDonationNonce, and pollForResult's post-timeout confirmation
 * probe (Scenario A).
 *
 * Deliberately does NOT mock '@stellar/stellar-sdk' — these tests build real
 * TransactionResult XDR via the SDK's own xdr namespace so the decode logic
 * is exercised against the real wire format, not a hand-rolled stand-in.
 */

import { xdr, SorobanRpc } from '@stellar/stellar-sdk'
import {
  decodeResultXdr,
  generateDonationNonce,
  pollForResult,
} from '@/hooks/use-donation'

// ---------------------------------------------------------------------------
// XDR fixture builders
// ---------------------------------------------------------------------------

function buildTxFailedResultXdr(opResults: xdr.OperationResult[]): string {
  const resultResult = xdr.TransactionResultResult.txFailed(opResults)
  const txResult = new xdr.TransactionResult({
    feeCharged: new xdr.Int64(100),
    result: resultResult,
    ext: new xdr.TransactionResultExt(0),
  })
  return txResult.toXDR('base64')
}

function buildOuterOnlyResultXdr(
  resultResult: xdr.TransactionResultResult,
): string {
  const txResult = new xdr.TransactionResult({
    feeCharged: new xdr.Int64(100),
    result: resultResult,
    ext: new xdr.TransactionResultExt(0),
  })
  return txResult.toXDR('base64')
}

function paymentOpResult(paymentResult: xdr.PaymentResult): xdr.OperationResult {
  return xdr.OperationResult.opInner(xdr.OperationResultTr.payment(paymentResult))
}

// ---------------------------------------------------------------------------
// decodeResultXdr
// ---------------------------------------------------------------------------

describe('decodeResultXdr', () => {
  it('distinguishes a txFailed/opINNER payment failure from a txFailed/opNO_DESTINATION failure', () => {
    // "payment failed" for a reason we don't have a dedicated message for
    // (paymentSrcNotAuthorized) — falls into the generic opINNER bucket.
    const innerXdr = buildTxFailedResultXdr([
      paymentOpResult(xdr.PaymentResult.paymentSrcNotAuthorized()),
    ])

    // Escrow account genuinely doesn't exist — a specific, actionable reason.
    const noDestinationXdr = buildTxFailedResultXdr([
      paymentOpResult(xdr.PaymentResult.paymentNoDestination()),
    ])

    const innerMsg = decodeResultXdr(innerXdr)
    const noDestMsg = decodeResultXdr(noDestinationXdr)

    expect(innerMsg).not.toBe(noDestMsg)
    expect(noDestMsg).toContain('escrow account does not exist')
    expect(innerMsg).toContain('payment or contract call')
  })

  it('maps a paymentUnderfunded operation result to the insufficient-balance message', () => {
    const resultXdr = buildTxFailedResultXdr([
      paymentOpResult(xdr.PaymentResult.paymentUnderfunded()),
    ])
    expect(decodeResultXdr(resultXdr)).toContain('Insufficient XLM balance')
  })

  it('maps the txBadSeq outer code to the sequence-conflict message when there is no inner result', () => {
    const resultXdr = buildOuterOnlyResultXdr(xdr.TransactionResultResult.txBadSeq())
    expect(decodeResultXdr(resultXdr)).toContain('Sequence number conflict')
  })

  it('maps the txInsufficientBalance outer code correctly', () => {
    const resultXdr = buildOuterOnlyResultXdr(xdr.TransactionResultResult.txInsufficientBalance())
    expect(decodeResultXdr(resultXdr)).toContain('Insufficient XLM balance')
  })

  it('falls back to a generic message for undecodable XDR without throwing', () => {
    const msg = decodeResultXdr('not-valid-base64-xdr-at-all')
    expect(typeof msg).toBe('string')
    expect(msg.length).toBeGreaterThan(0)
  })

  it('never returns an empty message for a txFailed result with no operation results', () => {
    const resultXdr = buildTxFailedResultXdr([])
    const msg = decodeResultXdr(resultXdr)
    expect(msg.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// generateDonationNonce
// ---------------------------------------------------------------------------

describe('generateDonationNonce', () => {
  it('is deterministic for the same idempotency key', () => {
    const key = 'GABC123:camp-42:100:58000000'
    expect(generateDonationNonce(key)).toBe(generateDonationNonce(key))
  })

  it('differs for different idempotency keys', () => {
    const a = generateDonationNonce('GABC123:camp-42:100:58000000')
    const b = generateDonationNonce('GABC123:camp-42:100:58000001')
    expect(a).not.toBe(b)
  })

  it('returns a fixed-length lowercase hex string', () => {
    const nonce = generateDonationNonce('GABC123:camp-1:1:1')
    expect(nonce).toMatch(/^[0-9a-f]{8}$/)
  })
})

// ---------------------------------------------------------------------------
// pollForResult — post-timeout confirmation probe (Scenario A)
// ---------------------------------------------------------------------------

describe('pollForResult', () => {
  const HASH = 'a'.repeat(64)

  function makeRpc(getTransactionImpl: () => Promise<{ status: string; resultXdr?: unknown }>) {
    return {
      getTransaction: jest.fn(getTransactionImpl),
    } as unknown as SorobanRpc.Server
  }

  beforeEach(() => {
    jest.useFakeTimers({ advanceTimers: true })
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('resolves immediately once getTransaction reports SUCCESS', async () => {
    const rpc = makeRpc(async () => ({ status: SorobanRpc.Api.GetTransactionStatus.SUCCESS }))

    const promise = pollForResult(rpc, HASH)
    await jest.advanceTimersByTimeAsync(2_000)

    await expect(promise).resolves.toBe(HASH)
  })

  it('detects a late success via the extra post-timeout probe instead of throwing (Scenario A)', async () => {
    let call = 0
    const rpc = makeRpc(async () => {
      call++
      // 30 regular polls return NOT_FOUND, the 31st call (the extra
      // post-timeout probe) reports SUCCESS.
      if (call <= 30) {
        return { status: SorobanRpc.Api.GetTransactionStatus.NOT_FOUND }
      }
      return { status: SorobanRpc.Api.GetTransactionStatus.SUCCESS }
    })

    const promise = pollForResult(rpc, HASH)
    await jest.advanceTimersByTimeAsync(31 * 2_000)

    await expect(promise).resolves.toBe(HASH)
    expect(call).toBe(31)
  })

  it('throws only after the extra probe also fails to find the transaction', async () => {
    const rpc = makeRpc(async () => ({ status: SorobanRpc.Api.GetTransactionStatus.NOT_FOUND }))

    const promise = pollForResult(rpc, HASH)
    promise.catch(() => {}) // avoid unhandled rejection warning while timers advance
    await jest.advanceTimersByTimeAsync(31 * 2_000)

    await expect(promise).rejects.toThrow(/timed out/i)
  })

  it('throws a decoded error message when getTransaction reports FAILED', async () => {
    const failedResultXdr = buildTxFailedResultXdr([
      paymentOpResult(xdr.PaymentResult.paymentNoDestination()),
    ])
    const rpc = makeRpc(async () => ({
      status: SorobanRpc.Api.GetTransactionStatus.FAILED,
      resultXdr: { toXDR: () => failedResultXdr },
    }))

    const promise = pollForResult(rpc, HASH)
    promise.catch(() => {})
    await jest.advanceTimersByTimeAsync(2_000)

    await expect(promise).rejects.toThrow(/escrow account does not exist/i)
  })
})
