/**
 * Unit tests for the claim-token modules.
 *
 * Signing + verification live in the server-only module
 * `claim-token.server.ts`; the pure, client-safe helpers live in
 * `claim-token.ts`. Imports below are split accordingly.
 *
 * Coverage:
 *  - generateClaimToken: produces a valid base64url-encoded JSON payload
 *  - validateClaimToken: valid token, expired token, wrong-address token,
 *    malformed token, invalid signature
 *  - isTokenExpiredSync: sync expiry check without crypto
 *  - getTokenExpiry: extracts expiry date
 *  - stroopsToXlm: conversion accuracy
 *  - formatClaimFeeXlm: display formatting
 *  - buildCanonicalMessage: deterministic ordering
 *  - base64urlEncode / base64urlDecode: round-trip
 *
 * The tests set process.env.CLAIM_TOKEN_SECRET to a fixed test secret and
 * reset the in-memory key ring so token generation and validation use the same
 * key deterministically.
 */

import {
  generateClaimToken,
  validateClaimToken,
  __resetClaimKeyRing,
} from '@/lib/beneficiary/claim-token.server'
import {
  isTokenExpiredSync,
  getTokenExpiry,
  stroopsToXlm,
  formatClaimFeeXlm,
  buildCanonicalMessage,
  base64urlEncode,
  base64urlDecode,
  TOKEN_TTL_SECONDS,
  CLOCK_SKEW_SECONDS,
} from '@/lib/beneficiary/claim-token'
import type { ClaimTokenPayload } from '@/types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_SECRET = 'test-secret-for-unit-tests'
const VALID_ADDRESS = 'GDQOE23CFSUMSVQK4Y5JHPPYK73VYCNHZHA7ENKCV37P6SUEO6XQBKPP'
const OTHER_ADDRESS = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN'
const CLAIM_ID = 'alloc-001'
const CAMPAIGN_ID = 'campaign-abc'
const AMOUNT_STROOPS = BigInt(100_000_000) // 10 XLM

beforeAll(() => {
  process.env.CLAIM_TOKEN_SECRET = TEST_SECRET
  // Rebuild the key ring so it derives from the test secret set above.
  __resetClaimKeyRing()
})

afterAll(() => {
  delete process.env.CLAIM_TOKEN_SECRET
  __resetClaimKeyRing()
})

// ---------------------------------------------------------------------------
// generateClaimToken
// ---------------------------------------------------------------------------

describe('generateClaimToken', () => {
  it('returns a non-empty base64url string', async () => {
    const token = await generateClaimToken(CLAIM_ID, VALID_ADDRESS, CAMPAIGN_ID, AMOUNT_STROOPS)
    expect(typeof token).toBe('string')
    expect(token.length).toBeGreaterThan(0)
    // base64url: no +, /, = padding
    expect(token).not.toMatch(/[+/=]/)
  })

  it('encodes all required fields in the payload', async () => {
    const token = await generateClaimToken(CLAIM_ID, VALID_ADDRESS, CAMPAIGN_ID, AMOUNT_STROOPS)
    const json = base64urlDecode(token)
    const payload = JSON.parse(json) as ClaimTokenPayload

    expect(payload.claimId).toBe(CLAIM_ID)
    expect(payload.beneficiaryAddress).toBe(VALID_ADDRESS)
    expect(payload.campaignId).toBe(CAMPAIGN_ID)
    expect(String(payload.allocatedAmount)).toBe(String(AMOUNT_STROOPS))
    expect(typeof payload.exp).toBe('number')
    expect(typeof payload.sig).toBe('string')
    expect(payload.sig.length).toBe(64) // HMAC-SHA256 = 32 bytes = 64 hex chars
  })

  it('sets exp to approximately now + TTL_SECONDS', async () => {
    const before = Math.floor(Date.now() / 1000)
    const token = await generateClaimToken(CLAIM_ID, VALID_ADDRESS, CAMPAIGN_ID, AMOUNT_STROOPS)
    const after = Math.floor(Date.now() / 1000)

    const json = base64urlDecode(token)
    const { exp } = JSON.parse(json) as ClaimTokenPayload

    expect(exp).toBeGreaterThanOrEqual(before + TOKEN_TTL_SECONDS)
    expect(exp).toBeLessThanOrEqual(after + TOKEN_TTL_SECONDS + 1)
  })

  it('respects custom ttlSeconds', async () => {
    const customTtl = 3600
    const before = Math.floor(Date.now() / 1000)
    const token = await generateClaimToken(CLAIM_ID, VALID_ADDRESS, CAMPAIGN_ID, AMOUNT_STROOPS, customTtl)
    const after = Math.floor(Date.now() / 1000)

    const json = base64urlDecode(token)
    const { exp } = JSON.parse(json) as ClaimTokenPayload

    expect(exp).toBeGreaterThanOrEqual(before + customTtl)
    expect(exp).toBeLessThanOrEqual(after + customTtl + 1)
  })

  it('produces different tokens for different claimIds', async () => {
    const t1 = await generateClaimToken('id-1', VALID_ADDRESS, CAMPAIGN_ID, AMOUNT_STROOPS)
    const t2 = await generateClaimToken('id-2', VALID_ADDRESS, CAMPAIGN_ID, AMOUNT_STROOPS)
    expect(t1).not.toBe(t2)
  })
})

// ---------------------------------------------------------------------------
// validateClaimToken — valid
// ---------------------------------------------------------------------------

describe('validateClaimToken — valid token', () => {
  it('returns valid: true and the full payload for a fresh token', async () => {
    const token = await generateClaimToken(CLAIM_ID, VALID_ADDRESS, CAMPAIGN_ID, AMOUNT_STROOPS)
    const result = await validateClaimToken(token, VALID_ADDRESS)

    expect(result.valid).toBe(true)
    if (!result.valid) return // narrow type

    expect(result.payload.claimId).toBe(CLAIM_ID)
    expect(result.payload.beneficiaryAddress).toBe(VALID_ADDRESS)
    expect(result.payload.campaignId).toBe(CAMPAIGN_ID)
  })
})

// ---------------------------------------------------------------------------
// validateClaimToken — expired
// ---------------------------------------------------------------------------

describe('validateClaimToken — expired token', () => {
  it('returns valid: false with reason "expired" when exp is in the past', async () => {
    // Build a token manually with exp already in the past (beyond clock skew)
    const expiredPayload: ClaimTokenPayload = {
      claimId: CLAIM_ID,
      beneficiaryAddress: VALID_ADDRESS,
      campaignId: CAMPAIGN_ID,
      allocatedAmount: String(AMOUNT_STROOPS),
      exp: Math.floor(Date.now() / 1000) - CLOCK_SKEW_SECONDS - 10, // clearly expired
      sig: 'a'.repeat(64), // will fail sig check, but expiry is checked first
    }

    const token = base64urlEncode(JSON.stringify(expiredPayload))
    const result = await validateClaimToken(token, VALID_ADDRESS)

    expect(result.valid).toBe(false)
    if (result.valid) return
    expect(result.reason).toBe('expired')
    expect(result.message).toMatch(/expired/i)
  })
})

// ---------------------------------------------------------------------------
// validateClaimToken — wrong address
// ---------------------------------------------------------------------------

describe('validateClaimToken — wrong address', () => {
  it('returns valid: false with reason "wrong-address" when wallet does not match', async () => {
    // Token is signed for VALID_ADDRESS but validated against OTHER_ADDRESS
    const token = await generateClaimToken(CLAIM_ID, VALID_ADDRESS, CAMPAIGN_ID, AMOUNT_STROOPS)
    const result = await validateClaimToken(token, OTHER_ADDRESS)

    expect(result.valid).toBe(false)
    if (result.valid) return
    expect(result.reason).toBe('wrong-address')
    expect(result.message).toMatch(/wallet/i)
  })
})

// ---------------------------------------------------------------------------
// validateClaimToken — malformed
// ---------------------------------------------------------------------------

describe('validateClaimToken — malformed token', () => {
  it('returns valid: false with reason "malformed" for garbage input', async () => {
    const result = await validateClaimToken('not-a-valid-token!!!', VALID_ADDRESS)
    expect(result.valid).toBe(false)
    if (result.valid) return
    expect(result.reason).toBe('malformed')
  })

  it('returns valid: false with reason "malformed" for valid base64 but not JSON', async () => {
    const token = base64urlEncode('this is not json {{{')
    const result = await validateClaimToken(token, VALID_ADDRESS)
    expect(result.valid).toBe(false)
    if (result.valid) return
    expect(result.reason).toBe('malformed')
  })

  it('returns valid: false with reason "malformed" for JSON missing required fields', async () => {
    const partial = base64urlEncode(JSON.stringify({ claimId: 'x' })) // missing most fields
    const result = await validateClaimToken(partial, VALID_ADDRESS)
    expect(result.valid).toBe(false)
    if (result.valid) return
    expect(result.reason).toBe('malformed')
  })
})

// ---------------------------------------------------------------------------
// validateClaimToken — invalid signature
// ---------------------------------------------------------------------------

describe('validateClaimToken — tampered signature', () => {
  it('returns valid: false with reason "invalid-signature" when sig is wrong', async () => {
    const token = await generateClaimToken(CLAIM_ID, VALID_ADDRESS, CAMPAIGN_ID, AMOUNT_STROOPS)

    // Decode, corrupt the sig, re-encode
    const json = base64urlDecode(token)
    const payload = JSON.parse(json) as ClaimTokenPayload
    payload.sig = 'f'.repeat(64) // all-f hex — almost certainly wrong
    const tampered = base64urlEncode(JSON.stringify(payload))

    const result = await validateClaimToken(tampered, VALID_ADDRESS)
    expect(result.valid).toBe(false)
    if (result.valid) return
    expect(result.reason).toBe('invalid-signature')
  })

  it('returns valid: false with reason "invalid-signature" when claimId is tampered', async () => {
    const token = await generateClaimToken(CLAIM_ID, VALID_ADDRESS, CAMPAIGN_ID, AMOUNT_STROOPS)

    const json = base64urlDecode(token)
    const payload = JSON.parse(json) as ClaimTokenPayload
    payload.claimId = 'different-claim-id' // tampered field; sig still belongs to original
    const tampered = base64urlEncode(JSON.stringify(payload))

    const result = await validateClaimToken(tampered, VALID_ADDRESS)
    expect(result.valid).toBe(false)
    if (result.valid) return
    expect(result.reason).toBe('invalid-signature')
  })
})

// ---------------------------------------------------------------------------
// isTokenExpiredSync
// ---------------------------------------------------------------------------

describe('isTokenExpiredSync', () => {
  it('returns false for a fresh token', async () => {
    const token = await generateClaimToken(CLAIM_ID, VALID_ADDRESS, CAMPAIGN_ID, AMOUNT_STROOPS)
    expect(isTokenExpiredSync(token)).toBe(false)
  })

  it('returns true when exp is in the past (beyond clock skew)', () => {
    const expired: Partial<ClaimTokenPayload> = {
      exp: Math.floor(Date.now() / 1000) - CLOCK_SKEW_SECONDS - 10,
    }
    const token = base64urlEncode(JSON.stringify(expired))
    expect(isTokenExpiredSync(token)).toBe(true)
  })

  it('returns true for garbage input', () => {
    expect(isTokenExpiredSync('not-valid')).toBe(true)
  })

  it('returns false when exp is in the future', () => {
    const future: Partial<ClaimTokenPayload> = {
      exp: Math.floor(Date.now() / 1000) + 3600,
    }
    const token = base64urlEncode(JSON.stringify(future))
    expect(isTokenExpiredSync(token)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getTokenExpiry
// ---------------------------------------------------------------------------

describe('getTokenExpiry', () => {
  it('returns the correct Date for a valid token', async () => {
    const before = Date.now()
    const token = await generateClaimToken(CLAIM_ID, VALID_ADDRESS, CAMPAIGN_ID, AMOUNT_STROOPS)
    const expiry = getTokenExpiry(token)

    expect(expiry).toBeInstanceOf(Date)
    expect(expiry!.getTime()).toBeGreaterThan(before)
  })

  it('returns null for garbage input', () => {
    expect(getTokenExpiry('garbage!!!')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// stroopsToXlm — formatting correctness (Acceptance criterion: fee in XLM)
// ---------------------------------------------------------------------------

describe('stroopsToXlm', () => {
  it('converts 10_000_000 stroops to 1 XLM', () => {
    expect(stroopsToXlm(10_000_000)).toBe(1)
  })

  it('converts 1 stroop to 0.0000001 XLM', () => {
    expect(stroopsToXlm(1)).toBeCloseTo(0.0000001, 7)
  })

  it('converts 0 stroops to 0', () => {
    expect(stroopsToXlm(0)).toBe(0)
  })

  it('handles bigint input', () => {
    expect(stroopsToXlm(BigInt(100_000_000))).toBe(10)
  })

  it('handles string input', () => {
    expect(stroopsToXlm('50000000')).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// formatClaimFeeXlm
// ---------------------------------------------------------------------------

describe('formatClaimFeeXlm', () => {
  it('formats 0.0001234 XLM with 7 decimal places', () => {
    expect(formatClaimFeeXlm(0.0001234)).toBe('0.0001234 XLM')
  })

  it('includes the XLM suffix', () => {
    expect(formatClaimFeeXlm(1)).toMatch(/XLM$/)
  })

  it('shows exactly 7 decimal places', () => {
    // 1 XLM → "1.0000000 XLM"
    const formatted = formatClaimFeeXlm(1)
    const parts = formatted.split('.')
    const decimals = parts[1].replace(' XLM', '')
    expect(decimals.length).toBe(7)
  })

  it('does not include 0x prefix', () => {
    expect(formatClaimFeeXlm(0.00005)).not.toMatch(/0x/)
  })
})

// ---------------------------------------------------------------------------
// buildCanonicalMessage
// ---------------------------------------------------------------------------

describe('buildCanonicalMessage', () => {
  it('produces a deterministic string for the same inputs', () => {
    const m1 = buildCanonicalMessage('id1', 'addr1', 'camp1', BigInt(100), 9999)
    const m2 = buildCanonicalMessage('id1', 'addr1', 'camp1', BigInt(100), 9999)
    expect(m1).toBe(m2)
  })

  it('differs when claimId changes', () => {
    const m1 = buildCanonicalMessage('id-A', 'addr', 'camp', BigInt(1), 0)
    const m2 = buildCanonicalMessage('id-B', 'addr', 'camp', BigInt(1), 0)
    expect(m1).not.toBe(m2)
  })

  it('contains all fields', () => {
    const msg = buildCanonicalMessage('ID', 'ADDR', 'CAMP', BigInt(42), 123)
    expect(msg).toContain('ID')
    expect(msg).toContain('ADDR')
    expect(msg).toContain('CAMP')
    expect(msg).toContain('42')
    expect(msg).toContain('123')
  })
})

// ---------------------------------------------------------------------------
// base64urlEncode / base64urlDecode
// ---------------------------------------------------------------------------

describe('base64url round-trip', () => {
  it('encodes and decodes ASCII strings correctly', () => {
    const original = '{"hello":"world","n":42}'
    expect(base64urlDecode(base64urlEncode(original))).toBe(original)
  })

  it('encodes and decodes unicode strings correctly', () => {
    const original = '{"emoji":"😀","cjk":"中文"}'
    expect(base64urlDecode(base64urlEncode(original))).toBe(original)
  })

  it('produces no + / = characters in the encoded output', () => {
    const encoded = base64urlEncode('any string that would produce padding')
    expect(encoded).not.toMatch(/[+/=]/)
  })
})
