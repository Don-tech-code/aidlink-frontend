/**
 * Unit tests for useDonation pure utility functions.
 *
 * These tests cover all pure functions extracted from the hook so they can run
 * without a React environment or a live Stellar network.
 */

import {
  xlmToStroops,
  stroopsToXlm,
  formatFeeXlm,
  buildIdempotencyKey,
  mapResultCode,
  classifyDonationError,
  DonationError,
  WalletNotConnectedError,
} from '@/hooks/use-donation'

// ---------------------------------------------------------------------------
// xlmToStroops — amount-to-stroop conversion
// ---------------------------------------------------------------------------

describe('xlmToStroops', () => {
  it('converts a whole number correctly', () => {
    expect(xlmToStroops(100)).toBe(1_000_000_000n)
  })

  it('converts the acceptance-criteria example: 100.1234567 XLM → 1001234567n', () => {
    expect(xlmToStroops(100.1234567)).toBe(1_001_234_567n)
  })

  it('converts the minimum amount: 1 stroop = 0.0000001 XLM', () => {
    expect(xlmToStroops(0.0000001)).toBe(1n)
  })

  it('handles zero', () => {
    expect(xlmToStroops(0)).toBe(0n)
  })

  it('handles a fractional XLM amount with full 7 decimal precision', () => {
    expect(xlmToStroops(0.1234567)).toBe(1_234_567n)
  })

  it('handles large amounts without overflow', () => {
    expect(xlmToStroops(500_000)).toBe(5_000_000_000_000n)
  })

  it('rounds floating-point drift correctly', () => {
    // 0.1 + 0.2 in JS is 0.30000000000000004 — make sure we round correctly
    const amount = 0.1 + 0.2 // 0.30000000000000004
    expect(xlmToStroops(amount)).toBe(3_000_000n)
  })
})

// ---------------------------------------------------------------------------
// stroopsToXlm — reverse conversion
// ---------------------------------------------------------------------------

describe('stroopsToXlm', () => {
  it('converts 10_000_000 stroops to 1 XLM', () => {
    expect(stroopsToXlm(10_000_000)).toBe(1)
  })

  it('converts 1 stroop to 0.0000001 XLM', () => {
    expect(stroopsToXlm(1)).toBeCloseTo(0.0000001, 7)
  })

  it('accepts a BigInt', () => {
    expect(stroopsToXlm(1_000_000_000n)).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// formatFeeXlm — fee display formatting
// ---------------------------------------------------------------------------

describe('formatFeeXlm', () => {
  it('formats to exactly 7 decimal places', () => {
    expect(formatFeeXlm(0.00001234)).toBe('0.0000123 XLM')
  })

  it('includes the XLM suffix', () => {
    const result = formatFeeXlm(0.00125)
    expect(result).toMatch(/XLM$/)
  })

  it('shows 7 decimal places even for whole numbers', () => {
    expect(formatFeeXlm(1)).toBe('1.0000000 XLM')
  })

  it('handles zero fee', () => {
    expect(formatFeeXlm(0)).toBe('0.0000000 XLM')
  })

  it('handles a typical testnet fee of 100 stroops + resource fee', () => {
    // ~100 + 5000 stroops ≈ 0.00051 XLM
    const feeXlm = stroopsToXlm(5_100)
    const formatted = formatFeeXlm(feeXlm)
    expect(formatted).toBe('0.0005100 XLM')
  })
})

// ---------------------------------------------------------------------------
// buildIdempotencyKey — key generation
// ---------------------------------------------------------------------------

describe('buildIdempotencyKey', () => {
  const DONOR = 'GABC123XYZ'
  const CAMPAIGN = 'camp-42'

  it('produces a string with four colon-separated segments', () => {
    const key = buildIdempotencyKey(DONOR, CAMPAIGN, 100)
    const parts = key.split(':')
    expect(parts).toHaveLength(4)
  })

  it('embeds the donor address', () => {
    const key = buildIdempotencyKey(DONOR, CAMPAIGN, 100)
    expect(key).toContain(DONOR)
  })

  it('embeds the campaign ID', () => {
    const key = buildIdempotencyKey(DONOR, CAMPAIGN, 100)
    expect(key).toContain(CAMPAIGN)
  })

  it('uses Math.floor of the amount (integer part)', () => {
    const key1 = buildIdempotencyKey(DONOR, CAMPAIGN, 99.99)
    const key2 = buildIdempotencyKey(DONOR, CAMPAIGN, 99.01)
    const key3 = buildIdempotencyKey(DONOR, CAMPAIGN, 100)
    // All three should have the same amount segment
    // key for 99.99 and 99.01 both floor to 99
    expect(key1.split(':')[2]).toBe('99')
    expect(key2.split(':')[2]).toBe('99')
    expect(key3.split(':')[2]).toBe('100')
  })

  it('generates the same key twice within the same 30-second window', () => {
    const key1 = buildIdempotencyKey(DONOR, CAMPAIGN, 50)
    const key2 = buildIdempotencyKey(DONOR, CAMPAIGN, 50)
    expect(key1).toBe(key2)
  })

  it('generates different keys for different donors', () => {
    const key1 = buildIdempotencyKey('DONOR_A', CAMPAIGN, 50)
    const key2 = buildIdempotencyKey('DONOR_B', CAMPAIGN, 50)
    expect(key1).not.toBe(key2)
  })

  it('generates different keys for different campaigns', () => {
    const key1 = buildIdempotencyKey(DONOR, 'camp-1', 50)
    const key2 = buildIdempotencyKey(DONOR, 'camp-2', 50)
    expect(key1).not.toBe(key2)
  })

  it('generates different keys for amounts that floor to different values', () => {
    const key1 = buildIdempotencyKey(DONOR, CAMPAIGN, 10)
    const key2 = buildIdempotencyKey(DONOR, CAMPAIGN, 11)
    expect(key1).not.toBe(key2)
  })
})

// ---------------------------------------------------------------------------
// mapResultCode — error code mapping
// ---------------------------------------------------------------------------

describe('mapResultCode', () => {
  it('maps txINSUFFICIENT_BALANCE to the correct message', () => {
    const msg = mapResultCode('txINSUFFICIENT_BALANCE')
    expect(msg).toContain('Insufficient XLM balance')
  })

  it('maps opNO_DESTINATION to the correct message', () => {
    const msg = mapResultCode('opNO_DESTINATION')
    expect(msg).toContain('escrow account does not exist')
  })

  it('maps txBAD_SEQ to the human-readable message per acceptance criteria', () => {
    const msg = mapResultCode('txBAD_SEQ')
    expect(msg).toContain('Sequence number conflict')
    expect(msg).toContain('try again')
  })

  it('maps txBAD_AUTH to an auth error message', () => {
    const msg = mapResultCode('txBAD_AUTH')
    expect(msg).toContain('signature is invalid')
  })

  it('maps opUNDERFUNDED to an insufficient balance message', () => {
    const msg = mapResultCode('opUNDERFUNDED')
    expect(msg).toContain('Insufficient XLM balance')
  })

  it('falls back gracefully for unknown error codes', () => {
    const msg = mapResultCode('txSOMETHING_NEW')
    expect(msg).toContain('txSOMETHING_NEW')
    expect(msg).toContain('try again')
  })

  it('handles an empty string code', () => {
    const msg = mapResultCode('')
    expect(typeof msg).toBe('string')
    expect(msg.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Integration: stroop round-trip
// ---------------------------------------------------------------------------

describe('stroop round-trip', () => {
  const cases: [number, bigint][] = [
    [1, 10_000_000n],
    [0.5, 5_000_000n],
    [100.1234567, 1_001_234_567n],
    [0.0000001, 1n],
    [999.9999999, 9_999_999_999n],
  ]

  test.each(cases)(
    '%f XLM converts to %s stroops',
    (xlm, expected) => {
      expect(xlmToStroops(xlm)).toBe(expected)
    },
  )

  it('round-trips via stroopsToXlm without precision loss for whole XLM', () => {
    const stroops = xlmToStroops(42)
    expect(stroopsToXlm(stroops)).toBe(42)
  })
})

// ---------------------------------------------------------------------------
// classifyDonationError — issue #61: user-friendly failure reasons
// ---------------------------------------------------------------------------

describe('classifyDonationError', () => {
  it('passes a DonationError message through unchanged', () => {
    const err = new DonationError('Insufficient XLM balance for this donation and transaction fee')
    expect(classifyDonationError(err)).toBe(
      'Insufficient XLM balance for this donation and transaction fee',
    )
  })

  it('gives a connect-wallet message for WalletNotConnectedError', () => {
    expect(classifyDonationError(new WalletNotConnectedError())).toBe(
      'Please connect your wallet to continue',
    )
  })

  it.each([
    'User declined access',
    'Request was rejected by the user',
    'User cancelled the request',
    'permission denied',
  ])('classifies wallet-rejection error "%s" as a cancellation message', (raw) => {
    expect(classifyDonationError(new Error(raw))).toBe(
      'You cancelled the request in your wallet — no funds were sent',
    )
  })

  it.each([
    'Failed to fetch',
    'NetworkError when attempting to fetch resource',
    'net::ERR_INTERNET_DISCONNECTED',
    'fetch failed',
  ])('classifies network error "%s" as a connectivity message', (raw) => {
    expect(classifyDonationError(new Error(raw))).toBe(
      'Network error — please check your internet connection and try again',
    )
  })

  it('classifies a client-side timeout as a friendly timeout message', () => {
    expect(classifyDonationError(new Error('The operation timed out'))).toBe(
      'The request took too long to respond — please check your connection and try again',
    )
  })

  it('classifies a missing Freighter extension as an install message', () => {
    expect(classifyDonationError(new Error('Freighter is not installed'))).toBe(
      'Freighter wallet extension not found — please install or unlock it and try again',
    )
  })

  it('classifies a simulation failure as a fee-estimation message', () => {
    expect(
      classifyDonationError(new Error('Transaction simulation failed: HostError: Error(Contract, #4)')),
    ).toBe('Unable to estimate the transaction fee right now — please try again in a moment')
  })

  it('classifies an escrow lookup failure as a campaign-address message', () => {
    expect(classifyDonationError(new Error('Failed to fetch campaign escrow address: XYZ'))).toBe(
      "We couldn't verify this campaign's donation address — please try again or contact support",
    )
  })

  it('never leaks raw XDR/SDK text for unrecognized errors', () => {
    const raw = 'Bad union switch: 42 at ScVal.address'
    const result = classifyDonationError(new Error(raw))
    expect(result).not.toContain('union switch')
    expect(result).toBe('Something went wrong while processing your donation — please try again')
  })

  it('handles non-Error thrown values without leaking internals', () => {
    expect(classifyDonationError('some raw string error')).toBe(
      'Something went wrong while processing your donation — please try again',
    )
    expect(classifyDonationError(undefined)).toBe(
      'Something went wrong while processing your donation — please try again',
    )
  })
})
