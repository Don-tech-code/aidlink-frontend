/**
 * Cryptographic utilities for beneficiary proof verification.
 *
 * All hashing uses the Web Crypto API (crypto.subtle) — no polyfills added.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Regex for a bare 64-character lowercase hex SHA-256 digest (no 0x prefix) */
const HEX_HASH_RE = /^[a-f0-9]{64}$/i

/** Prefix prepended to a local SHA-256 digest so it is visually distinct from IPFS CIDs */
export const SHA256_PREFIX = 'sha256:'

// ---------------------------------------------------------------------------
// SHA-256 hashing
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 digest of an ArrayBuffer and return it as a lowercase
 * hex string (64 characters, no prefix).
 *
 * Uses the Web Crypto API — no external dependencies required.
 *
 * @example
 * const buf = new TextEncoder().encode('hello')
 * const hex = await sha256Hex(buf)
 * // → '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
 */
export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Compute the SHA-256 digest of a File and return it as a prefixed CID string.
 *
 * The prefix `sha256:` disambiguates from IPFS CIDs and signals the proof
 * storage mechanism to the contract.
 *
 * @param file  The File object from a browser file-input element.
 * @returns     A string like `sha256:2cf24dba…` (70 characters total).
 */
export async function hashFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  const hex = await sha256Hex(buffer)
  return `${SHA256_PREFIX}${hex}`
}

// ---------------------------------------------------------------------------
// Proof-hash validation
// ---------------------------------------------------------------------------

export type ProofValidationResult =
  | { valid: true; normalised: string }
  | { valid: false; error: string }

/**
 * Validate a user-supplied on-chain proof hash.
 *
 * Accepts:
 *  - Bare 64-character hex strings (Stellar/Soroban tx hashes)
 *
 * Rejects with a descriptive error:
 *  - 0x-prefixed Ethereum-style hashes
 *  - Strings that are not 64 hex characters
 *
 * @returns `{ valid: true, normalised }` where `normalised` is the lowercase hash,
 *          or `{ valid: false, error }` with a user-facing message.
 */
export function validateOnChainHash(input: string): ProofValidationResult {
  const trimmed = input.trim()

  if (trimmed.startsWith('0x') || trimmed.startsWith('0X')) {
    return {
      valid: false,
      error:
        'This looks like an Ethereum-style hash (0x-prefixed). ' +
        'Stellar transaction hashes do not use a 0x prefix. ' +
        'Please paste the 64-character hex hash without the 0x prefix.',
    }
  }

  if (!HEX_HASH_RE.test(trimmed)) {
    return {
      valid: false,
      error:
        'The proof hash must be exactly 64 lowercase hexadecimal characters ' +
        `(a–f, 0–9). The value you entered has ${trimmed.length} character${
          trimmed.length === 1 ? '' : 's'
        }.`,
    }
  }

  return { valid: true, normalised: trimmed.toLowerCase() }
}

// ---------------------------------------------------------------------------
// Rejection-reason byte-length guard
// ---------------------------------------------------------------------------

/** Maximum UTF-8 byte length allowed for a rejection reason string. */
export const MAX_REASON_BYTES = 256

/**
 * Count the UTF-8 byte length of a string (not code-unit length).
 * Uses TextEncoder so multi-byte characters (e.g. emoji, CJK) are counted correctly.
 */
export function reasonByteLength(str: string): number {
  return new TextEncoder().encode(str).length
}

/**
 * Validate a rejection reason string before sending it to the contract.
 *
 * @returns `{ valid: true }` or `{ valid: false, error, byteLength }`.
 */
export function validateRejectionReason(reason: string): {
  valid: boolean
  error?: string
  byteLength: number
} {
  const byteLength = reasonByteLength(reason)

  if (reason.trim().length === 0) {
    return { valid: false, error: 'Rejection reason must not be empty.', byteLength }
  }

  if (byteLength > MAX_REASON_BYTES) {
    return {
      valid: false,
      error: `Rejection reason is too long (${byteLength} bytes). Maximum is ${MAX_REASON_BYTES} bytes.`,
      byteLength,
    }
  }

  return { valid: true, byteLength }
}
