/**
 * Claim token helpers for the AidLink beneficiary portal (client-safe).
 *
 * Design
 * ──────
 * A claim token is a compact, signed envelope that uniquely identifies a single
 * allocation being claimed.  It is encoded as base64url-JSON so standard QR
 * readers can scan it.
 *
 * The structure includes: claimId, beneficiaryAddress, campaignId,
 * allocatedAmount, exp (Unix seconds), an optional `kid` (signing-key id), and
 * an HMAC-SHA256 signature over the canonical fields.
 *
 * Security
 * ──────
 * • The HMAC signing secret NEVER reaches the browser. All signing and
 *   signature verification live in the server-only module
 *   `claim-token.server.ts` (which does `import 'server-only'`) and are exposed
 *   to the client exclusively through the `/api/v1/claim-token` endpoints.
 * • This module contains ONLY the pure, non-secret helpers that both the client
 *   and the server need: canonical-message construction, base64url encode/
 *   decode, and the sync expiry/formatting utilities used to render the UI.
 * • Because nothing here touches the secret, importing it into a client bundle
 *   cannot leak key material.
 * • No npm dependencies are added — Web Crypto is used server-side; this file is
 *   dependency-free.
 */

import type { ClaimTokenPayload } from '@/types'

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
 *
 * NOTE: `kid` is intentionally NOT part of the canonical message — it only
 * selects which key verifies the signature, so the same token body stays
 * verifiable regardless of which ring key produced it.
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
// Sync (no-crypto) helpers
// ---------------------------------------------------------------------------

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
