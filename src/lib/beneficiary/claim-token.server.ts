/**
 * Claim token signing + verification — SERVER ONLY.
 *
 * `import 'server-only'` makes any attempt to pull this module into a client
 * bundle a hard build error, so the HMAC signing secret can never be shipped to
 * the browser. The client reaches this code exclusively through the
 * `/api/v1/claim-token` and `/api/v1/claim-token/validate` route handlers.
 *
 * Secret handling
 * ───────────────
 * • The signing secret is read from `CLAIM_TOKEN_SECRET` only. The old
 *   `NEXT_PUBLIC_CLAIM_TOKEN_SECRET` is never consulted — a `NEXT_PUBLIC_`
 *   variable is inlined into the client bundle, which was the original leak.
 * • If `CLAIM_TOKEN_SECRET` is unset outside production, an ephemeral random key
 *   is generated once at startup so the flow still works locally; a single
 *   warning is logged. In production a missing secret is fatal (fail closed).
 *
 * Key ring / rotation
 * ───────────────────
 * • A small in-memory ring holds the current signing key plus one previous key.
 * • New tokens are signed with the current key and tagged with its `kid`.
 * • After a rotation the previous key stays in the ring, so tokens it signed
 *   keep validating until they hit their own TTL. A second rotation drops the
 *   oldest key entirely, after which its tokens no longer verify.
 * • Tokens with no `kid` (issued before ring support) are verified against every
 *   key currently in the ring for backward compatibility.
 *
 * Crypto: Web Crypto (`crypto.subtle`) only — no npm crypto dependencies.
 */

import 'server-only'

import type { ClaimTokenPayload, ClaimTokenValidation } from '@/types'
import {
  buildCanonicalMessage,
  base64urlEncode,
  base64urlDecode,
  CLOCK_SKEW_SECONDS,
  TOKEN_TTL_SECONDS,
} from './claim-token'

// ---------------------------------------------------------------------------
// HMAC primitives (Web Crypto)
// ---------------------------------------------------------------------------

/** Import a raw HMAC-SHA256 key from an arbitrary string secret. */
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

/** Compute HMAC-SHA256 of `message`, returned as a lowercase hex string. */
async function hmacSign(key: CryptoKey, message: string): Promise<string> {
  const data = new TextEncoder().encode(message)
  const signature = await crypto.subtle.sign('HMAC', key, data)
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Verify a hex-encoded HMAC signature against `message` using `key`.
 *
 * crypto.subtle.verify is timing-safe; we re-compute over the provided bytes
 * and let the API compare so we never hand-roll a timing-safe comparison.
 */
async function hmacVerify(
  key: CryptoKey,
  message: string,
  hexSig: string,
): Promise<boolean> {
  try {
    const pairs = hexSig.match(/.{2}/g)
    if (!pairs) return false
    const sigBytes = new Uint8Array(pairs.map((b) => parseInt(b, 16)))
    const data = new TextEncoder().encode(message)
    return await crypto.subtle.verify('HMAC', key, sigBytes, data)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Key ring
// ---------------------------------------------------------------------------

interface RingKey {
  /** Short identifier embedded in tokens signed with this key. */
  kid: string
  /** Imported HMAC key. */
  key: CryptoKey
}

/** Current key + one previous key. */
const MAX_RING_SIZE = 2

/**
 * The exact warning emitted (once) when running without a configured secret.
 * Kept verbatim — monitoring/tests match on this string.
 */
const EPHEMERAL_WARNING =
  '[claim-token] WARNING: using ephemeral dev key — set CLAIM_TOKEN_SECRET in production'

// Ring state is a promise so concurrent callers share a single initialization.
// Index 0 is always the current (signing) key.
let ringPromise: Promise<RingKey[]> | null = null
let warnedEphemeral = false

/** Generate a random 32-byte secret as hex (dev fallback only). */
function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Derive a short, stable key id from a secret. Deterministic so that the same
 * configured `CLAIM_TOKEN_SECRET` always yields the same `kid` across restarts,
 * keeping already-issued tokens verifiable after a redeploy.
 */
async function deriveKid(secret: string): Promise<string> {
  const data = new TextEncoder().encode('aidlink-kid:' + secret)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .slice(0, 4)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('') // 8 hex chars
}

async function makeKey(secret: string): Promise<RingKey> {
  return { kid: await deriveKid(secret), key: await importHmacKey(secret) }
}

/**
 * Resolve the initial signing secret from the environment.
 * Fails closed in production; falls back to an ephemeral key elsewhere.
 */
function resolveInitialSecret(): string {
  const secret =
    (typeof process !== 'undefined' && process.env?.CLAIM_TOKEN_SECRET) || ''

  if (secret) return secret

  const isProduction =
    typeof process !== 'undefined' && process.env?.NODE_ENV === 'production'
  if (isProduction) {
    throw new Error(
      '[claim-token] CLAIM_TOKEN_SECRET is not set. Refusing to sign claim tokens in production.',
    )
  }

  if (!warnedEphemeral) {
    console.warn(EPHEMERAL_WARNING)
    warnedEphemeral = true
  }
  return randomSecret()
}

/** Lazily initialize the key ring (once) and return it. */
function ensureRing(): Promise<RingKey[]> {
  if (!ringPromise) {
    ringPromise = (async () => [await makeKey(resolveInitialSecret())])()
  }
  return ringPromise
}

/**
 * Rotate the signing key. The current key becomes the previous key (kept for
 * verifying tokens it already signed) and a new current key takes its place.
 * The oldest key beyond {@link MAX_RING_SIZE} is dropped from the ring.
 *
 * @param newSecret  Optional explicit secret for the new current key. When
 *                   omitted a random ephemeral secret is used.
 * @returns          The `kid` of the new current key.
 */
export async function rotateClaimKey(newSecret?: string): Promise<string> {
  const current = await ensureRing()
  const next = await makeKey(newSecret ?? randomSecret())
  ringPromise = Promise.resolve([next, ...current].slice(0, MAX_RING_SIZE))
  return next.kid
}

/**
 * Reset the in-memory key ring. Test-only — lets each test start from a known
 * state derived from the current `CLAIM_TOKEN_SECRET`.
 * @internal
 */
export function __resetClaimKeyRing(): void {
  ringPromise = null
  warnedEphemeral = false
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
  allocatedAmountStroops: bigint | number | string,
  ttlSeconds: number = TOKEN_TTL_SECONDS,
): Promise<string> {
  const ring = await ensureRing()
  const current = ring[0]

  const exp = Math.floor(Date.now() / 1000) + ttlSeconds
  const allocatedAmount = String(allocatedAmountStroops)

  const canonical = buildCanonicalMessage(
    claimId,
    beneficiaryAddress,
    campaignId,
    allocatedAmount,
    exp,
  )
  const sig = await hmacSign(current.key, canonical)

  const payload: ClaimTokenPayload = {
    claimId,
    beneficiaryAddress,
    campaignId,
    allocatedAmount, // stored as string — bigint is not JSON-serialisable
    exp,
    sig,
    kid: current.kid,
  }

  return base64urlEncode(JSON.stringify(payload))
}

/**
 * Decode and validate a claim token string.
 *
 * Validates, in order:
 *  1. JSON is well-formed and all required fields are present  → 'malformed'
 *  2. Token has not expired (clock-skew tolerance: ±30 s)      → 'expired'
 *  3. HMAC signature is correct for a key still in the ring     → 'invalid-signature'
 *  4. Token is intended for the provided wallet address         → 'wrong-address'
 *
 * @param tokenString       The base64url-encoded payload (from QR scan or prop).
 * @param connectedAddress  The currently connected Stellar wallet address.
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
      message: 'This claim token has expired. Refresh the page for a new one.',
    }
  }

  // 4 — Verify HMAC signature against the key ring.
  const ring = await ensureRing()
  const canonical = buildCanonicalMessage(
    fullPayload.claimId,
    fullPayload.beneficiaryAddress,
    fullPayload.campaignId,
    String(fullPayload.allocatedAmount),
    fullPayload.exp,
  )

  let sigValid = false
  if (typeof fullPayload.kid === 'string' && fullPayload.kid.length > 0) {
    // Tagged token: verify only against the named key. If that key has aged out
    // of the ring, the token can no longer be verified and is rejected.
    const match = ring.find((k) => k.kid === fullPayload.kid)
    if (match) {
      sigValid = await hmacVerify(match.key, canonical, fullPayload.sig)
    }
  } else {
    // Legacy token with no kid: accept if any current ring key verifies it.
    for (const k of ring) {
      if (await hmacVerify(k.key, canonical, fullPayload.sig)) {
        sigValid = true
        break
      }
    }
  }

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
