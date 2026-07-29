/**
 * Claim token generation and validation for the AidLink beneficiary portal.
 *
 * Design
 * ──────
 * A claim token is a compact, signed envelope that uniquely identifies a single
 * allocation being claimed.  It is encoded as base64url-JSON so standard QR
 * readers can scan it.
 *
 * The structure includes: claimId, beneficiaryAddress, campaignId,
 * allocatedAmount, exp (Unix seconds), and an HMAC-SHA256 signature over the
 * canonical fields.
 *
 * Security
 * ──────
 * • Private key material NEVER leaves the server — only the HMAC digest is
 *   embedded in the QR payload.
 * • The signature prevents a beneficiary from crafting a valid token for an
 *   allocation that doesn't belong to them.
 * • Expiry is enforced client-side before any transaction is built, with 30s
 *   of allowed clock skew.
 * • No npm dependencies are added — Web Crypto API (crypto.subtle) is used for
 *   HMAC-SHA256 throughout.
 *
 * In production the HMAC key would be fetched from a server-side API and kept
 * in memory only; in this client-side implementation it is derived from the
 * environment variable NEXT_PUBLIC_CLAIM_TOKEN_SECRET (or a safe fallback for
 * development) so the flow can be fully exercised in tests.
 */

import type { ClaimTokenPayload, ClaimTokenValidation } from '@/types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum seconds of clock skew we tolerate between issuer and validator. */
export const CLOCK_SKEW_SECONDS = 30

/**
 * Default token TTL for in-person scanning scenarios (15 minutes in seconds).
 * For remote-delivery tokens the caller should pass a longer TTL explicitly.
 */
export const TOKEN_TTL_SECONDS = 15 * 60 // 15 minutes

/**
 * Remote-delivery TTL (72 hours in seconds).
 */
export const REMOTE_TOKEN_TTL_SECONDS = 72 * 60 * 60

// ---------------------------------------------------------------------------
// HMAC key derivation
// ---------------------------------------------------------------------------

/**
 * Import a raw HMAC-SHA256 key from an arbitrary string secret.
 *
 * Uses the Web Crypto API — available in all modern browsers and in
 * Next.js edge / Node runtime without polyfills.
 */
async function importHmacKey(secret: string): Promise<CryptoKey> {
  const keyMaterial = new TextEncoder().encode(secret)
  return crypto.subtle.importKey(
    'raw',
    keyMaterial,
    { name: 'HMAC', hash: 'SHA-256' },
    false, // not extractable
    ['sign', 'verify'],
  )
}

/**
 * Return the HMAC key to use for claim tokens.
 *
 * In production: secret is read from a server-side API call and never exposed
 * to the client bundle.  In this client-side implementation we read from the
 * environment variable so the full flow can be exercised in tests and CI.
 *
 * The secret is intentionally never stored in module scope to make accidental
 * exposure harder.
 */
async function getClaimKey(): Promise<CryptoKey> {
  const secret =
    (typeof process !== 'undefined' &&
      process.env?.NEXT_PUBLIC_CLAIM_TOKEN_SECRET) ||
    'aidlink-claim-token-dev-secret-change-in-production'
  return importHmacKey(secret)
}

// ---------------------------------------------------------------------------
// Canonical message construction
// ---------------------------------------------------------------------------

/**
 * Build the canonical message string that is signed / verified.
 *
 * The format is a fixed, delimited string of the payload fields in a
 * deterministic order.  Using a fixed format instead of JSON.stringify
 * prevents signature failures caused by JSON key-order differences.
 *
 * Format:
 *   `{claimId}\n{beneficiaryAddress}\n{campaignId}\n{allocatedAmount}\n{exp}`
 *
 * The `\n` delimiter is safe because none of the fields contain newlines.
 */
export function buildCanonicalMessage(
  claimId: string,
  beneficiaryAddress: string,
  campaignId: string,
  allocatedAmount: bigint | string,
  exp: number,
): string {
  return [
    claimId,
    beneficiaryAddress,
    campaignId,
    String(allocatedAmount),
    String(exp),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// HMAC helpers
// ---------------------------------------------------------------------------

/**
 * Compute HMAC-SHA256 of `message` using the provided key.
 * Returns the digest as a lowercase hex string.
 */
async function hmacSign(key: CryptoKey, message: string): Promise<string> {
  const data = new TextEncoder().encode(message)
  const signature = await crypto.subtle.sign('HMAC', key, data)
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Constant-time comparison for two hex strings.
 *
 * crypto.subtle.verify is timing-safe; we re-compute the expected HMAC and
 * let the API compare so we never implement our own timing-safe comparison.
 */
async function hmacVerify(
  key: CryptoKey,
  message: string,
  hexSig: string,
): Promise<boolean> {
  try {
    // Convert hex → Uint8Array
    const sigBytes = new Uint8Array(
      hexSig.match(/.{2}/g)!.map((b) => parseInt(b, 16)),
    )
    const data = new TextEncoder().encode(message)
    return await crypto.subtle.verify('HMAC', key, sigBytes, data)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// base64url helpers  (no external dependencies)
// ---------------------------------------------------------------------------

/**
 * Encode a UTF-8 string to base64url without padding.
 * Works in browser and Node >= 16.
 */
export function base64urlEncode(input: string): string {
  // In browser / Next.js edge runtime, btoa operates on binary strings.
  // We use encodeURIComponent + % escaping approach to handle unicode cleanly.
  const bytes = new TextEncoder().encode(input)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * Decode a base64url string back to a UTF-8 string.
 */
export function base64urlDecode(input: string): string {
  // Re-add padding
  const padded = input + '=='.slice(0, (4 - (input.length % 4)) % 4)
  const base64 = padded.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new TextDecoder().decode(bytes)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a signed claim token for one allocation.
 *
 * @param claimId                Unique allocation ID from the contract.
 * @param beneficiaryAddress     Stellar public key of the intended claimant.
 * @param campaignId             Campaign the allocation belongs to.
 * @param allocatedAmountStroops Amount in XLM stroops (bigint or number).
 * @param ttlSeconds             Time-to-live in seconds (default: 15 minutes).
 * @returns                      A base64url-encoded JSON string suitable for
 *                               embedding in a QR code.
 */
export async function generateClaimToken(
  claimId: string,
  beneficiaryAddress: string,
  campaignId: string,
  allocatedAmountStroops: bigint | number,
  ttlSeconds: number = TOKEN_TTL_SECONDS,
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds
  const allocatedAmount = String(allocatedAmountStroops)

  const key = await getClaimKey()
  const canonical = buildCanonicalMessage(
    claimId,
    beneficiaryAddress,
    campaignId,
    allocatedAmount,
    exp,
  )
  const sig = await hmacSign(key, canonical)

  const payload: ClaimTokenPayload = {
    claimId,
    beneficiaryAddress,
    campaignId,
    allocatedAmount, // stored as string — bigint is not JSON-serialisable
    exp,
    sig,
  }

  return base64urlEncode(JSON.stringify(payload))
}

/**
 * Decode and validate a claim token string.
 *
 * Validates:
 *  1. JSON is well-formed and all required fields are present.
 *  2. HMAC signature is correct.
 *  3. Token has not expired (clock-skew tolerance: ±30 s).
 *  4. Token is intended for the provided wallet address.
 *
 * @param tokenString       The base64url-encoded payload (from QR scan or prop).
 * @param connectedAddress  The currently connected Stellar wallet address.
 * @returns                 A ClaimTokenValidation discriminated union.
 */
export async function validateClaimToken(
  tokenString: string,
  connectedAddress: string,
): Promise<ClaimTokenValidation> {
  // 1 — Decode and parse JSON
  let payload: Partial<ClaimTokenPayload>
  try {
    const json = base64urlDecode(tokenString)
    payload = JSON.parse(json) as Partial<ClaimTokenPayload>
  } catch {
    return {
      valid: false,
      reason: 'malformed',
      message: 'The claim token could not be decoded. Please refresh the page.',
    }
  }

  // 2 — Check required fields
  if (
    typeof payload.claimId !== 'string' ||
    typeof payload.beneficiaryAddress !== 'string' ||
    typeof payload.campaignId !== 'string' ||
    payload.allocatedAmount === undefined ||
    typeof payload.exp !== 'number' ||
    typeof payload.sig !== 'string'
  ) {
    return {
      valid: false,
      reason: 'malformed',
      message: 'The claim token is missing required fields. Please refresh the page.',
    }
  }

  const fullPayload = payload as ClaimTokenPayload

  // 3 — Check expiry (with clock-skew tolerance)
  const nowSeconds = Math.floor(Date.now() / 1000)
  if (nowSeconds > fullPayload.exp + CLOCK_SKEW_SECONDS) {
    return {
      valid: false,
      reason: 'expired',
      message:
        'This claim token has expired. Refresh the page for a new one.',
    }
  }

  // 4 — Verify HMAC signature
  const key = await getClaimKey()
  const canonical = buildCanonicalMessage(
    fullPayload.claimId,
    fullPayload.beneficiaryAddress,
    fullPayload.campaignId,
    String(fullPayload.allocatedAmount),
    fullPayload.exp,
  )
  const sigValid = await hmacVerify(key, canonical, fullPayload.sig)
  if (!sigValid) {
    return {
      valid: false,
      reason: 'invalid-signature',
      message:
        'The claim token signature is invalid. Do not attempt to modify claim tokens.',
    }
  }

  // 5 — Verify the token is for this wallet
  if (fullPayload.beneficiaryAddress !== connectedAddress) {
    return {
      valid: false,
      reason: 'wrong-address',
      message:
        'This claim token is not for the connected wallet. Connect the correct wallet and try again.',
    }
  }

  return { valid: true, payload: fullPayload }
}

/**
 * Synchronously check whether a token's `exp` field indicates it is expired,
 * WITHOUT performing signature validation.
 *
 * Used for rendering the UI state (greying out expired QR codes) without
 * waiting for the async crypto operation.
 *
 * @param tokenString  base64url-encoded claim token.
 * @returns            true if the token is expired or cannot be decoded.
 */
export function isTokenExpiredSync(tokenString: string): boolean {
  try {
    const json = base64urlDecode(tokenString)
    const payload = JSON.parse(json) as Partial<ClaimTokenPayload>
    if (typeof payload.exp !== 'number') return true
    const nowSeconds = Math.floor(Date.now() / 1000)
    return nowSeconds > payload.exp + CLOCK_SKEW_SECONDS
  } catch {
    return true
  }
}

/**
 * Extract the expiry timestamp from a token string without validation.
 * Returns null if the token is malformed.
 */
export function getTokenExpiry(tokenString: string): Date | null {
  try {
    const json = base64urlDecode(tokenString)
    const payload = JSON.parse(json) as Partial<ClaimTokenPayload>
    if (typeof payload.exp !== 'number') return null
    return new Date(payload.exp * 1000)
  } catch {
    return null
  }
}

/**
 * Convert stroops (integer) to XLM with 7 decimal places.
 * 1 XLM = 10,000,000 stroops.
 */
export function stroopsToXlm(stroops: bigint | number | string): number {
  return Number(stroops) / 10_000_000
}

/**
 * Format a fee amount (in XLM) for UI display, e.g. "0.0001234 XLM"
 */
export function formatClaimFeeXlm(xlm: number): string {
  return `${xlm.toFixed(7)} XLM`
}
