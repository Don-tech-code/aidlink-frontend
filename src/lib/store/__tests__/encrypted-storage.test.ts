/**
 * Unit tests for the encrypted storage adapter and wallet store persistence.
 *
 * AES-GCM is an AEAD cipher — it provides both confidentiality and
 * authentication via its built-in GCM authentication tag.  An explicit
 * HMAC over the ciphertext is therefore redundant because AES-GCM
 * already guarantees that any tampering will be detected during
 * decryption (crypto.subtle.decrypt throws if the auth tag is
 * invalid).  No separate HMAC is needed.
 */

import { encryptedStorage, persistedStateSchema, clearSessionKeyCache } from '../encrypted-storage'

const STORAGE_KEY = 'wallet-storage'
const SESSION_KEY_KEY = 'aidlink:wallet:sessionKey'

const VALID_ADDRESS = 'GB5XWAMU7QNOZBU4K7L5KGK46XB5HQDJC7W3COSKZQD5NVD4M7Y4Q2K7'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  clearSessionKeyCache()
  jest.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Helper: wait for crypto async operations to settle
// ---------------------------------------------------------------------------
async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20))
}

// ---------------------------------------------------------------------------
// Test 1: Encryption hides sensitive data from localStorage
// ---------------------------------------------------------------------------
describe('encrypted-storage', () => {
  it('does not store the wallet address as plaintext in localStorage', async () => {
    const value = {
      state: {
        isConnected: true,
        address: VALID_ADDRESS,
        network: 'testnet' as const,
        connectedAt: Date.now(),
      },
      version: 0,
    }

    await encryptedStorage.setItem!(STORAGE_KEY, value as any)
    await tick()

    const stored = localStorage.getItem(STORAGE_KEY)
    expect(stored).not.toBeNull()

    // The stored blob does not contain the address as plaintext
    expect(stored!).not.toContain(VALID_ADDRESS)

    // The stored blob is { iv, ciphertext }
    const parsed = JSON.parse(stored!)
    expect(parsed).toHaveProperty('iv')
    expect(parsed).toHaveProperty('ciphertext')
    expect(Object.keys(parsed)).toEqual(['iv', 'ciphertext'])
  })

  // -------------------------------------------------------------------------
  // Test 2: Missing session key yields null
  // -------------------------------------------------------------------------
  it('returns null from getItem when sessionStorage has no key', async () => {
    // Write some encrypted data first (this creates a session key)
    await encryptedStorage.setItem!(STORAGE_KEY, {
      state: {
        isConnected: true,
        address: VALID_ADDRESS,
        network: 'testnet',
        connectedAt: Date.now(),
      },
      version: 0,
    } as any)
    await tick()

    // Simulate new tab: clear session key and module-level cache
    sessionStorage.removeItem(SESSION_KEY_KEY)
    clearSessionKeyCache()

    const result = await encryptedStorage.getItem!(STORAGE_KEY)
    expect(result).toBeNull()

    // The entry should also be cleared from localStorage
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Test 3: Tampered ciphertext → getItem returns null, warning logged
  // -------------------------------------------------------------------------
  it('returns null and warns when ciphertext is tampered with', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

    // Write a valid encrypted payload
    await encryptedStorage.setItem!(STORAGE_KEY, {
      state: {
        isConnected: true,
        address: VALID_ADDRESS,
        network: 'testnet',
        connectedAt: Date.now(),
      },
      version: 0,
    } as any)
    await tick()

    // Corrupt the ciphertext by flipping a byte
    const blob = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
    const ct = Uint8Array.from(atob(blob.ciphertext), (c) => c.charCodeAt(0))
    ct[0] ^= 0xff
    blob.ciphertext = btoa(String.fromCharCode(...ct))
    localStorage.setItem(STORAGE_KEY, JSON.stringify(blob))

    // Re-hydrate — AES-GCM auth tag check fails
    const result = await encryptedStorage.getItem!(STORAGE_KEY)
    expect(result).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('possible tampering')
    )
  })

  // -------------------------------------------------------------------------
  // Test 4: Expired TTL → onRehydrateStorage calls disconnect
  // -------------------------------------------------------------------------
  it('calls disconnect when connectedAt is older than session TTL', async () => {
    const SESSION_TTL_MS = 28_800_000
    const expiredAt = Date.now() - 9 * 3600 * 1000 // 9 hours ago

    // Pre-populate encrypted storage with an expired session
    await encryptedStorage.setItem!(STORAGE_KEY, {
      state: {
        isConnected: true,
        address: VALID_ADDRESS,
        network: 'testnet',
        connectedAt: expiredAt,
      },
      version: 0,
    } as any)
    await tick()

    // Create a store with TTL checking onRehydrateStorage
    const { create } = await import('zustand')
    const { persist } = await import('zustand/middleware')
    let disconnected = false
    const store = create<{
      isConnected: boolean
      connectedAt: number | null
      disconnect: () => void
    }>()(
      persist(
        (set) => ({
          isConnected: false,
          connectedAt: null,
          disconnect: () => {
            disconnected = true
            set({ isConnected: false, connectedAt: null })
          },
        }),
        {
          name: STORAGE_KEY,
          storage: encryptedStorage,
          onRehydrateStorage: () => (state) => {
            if (!state) return
            if (state.isConnected && state.connectedAt != null) {
              if (Date.now() - state.connectedAt > SESSION_TTL_MS) {
                store.getState().disconnect()
              }
            }
          },
        }
      )
    )

    await store.persist.rehydrate()
    await tick()

    expect(disconnected).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Test 5: Invalid address → Zod validation fails → getItem returns null
  // -------------------------------------------------------------------------
  it('returns null when persisted address is not a valid Stellar key', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

    // Write a payload with an invalid address via the encrypted adapter
    await encryptedStorage.setItem!(STORAGE_KEY, {
      state: {
        isConnected: true,
        address: 'not-a-stellar-key',
        network: 'testnet',
        connectedAt: Date.now(),
      },
      version: 0,
    } as any)
    await tick()

    const result = await encryptedStorage.getItem!(STORAGE_KEY)
    expect(result).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('possible tampering'),
      expect.anything()
    )
  })

  // -------------------------------------------------------------------------
  // Test 6: setItem creates a session key if none exists
  // -------------------------------------------------------------------------
  it('creates a session key in sessionStorage after setItem', async () => {
    expect(sessionStorage.getItem(SESSION_KEY_KEY)).toBeNull()

    await encryptedStorage.setItem!(STORAGE_KEY, {
      state: {
        isConnected: true,
        address: VALID_ADDRESS,
        network: 'testnet',
        connectedAt: Date.now(),
      },
      version: 0,
    } as any)
    await tick()

    const key = sessionStorage.getItem(SESSION_KEY_KEY)
    expect(key).not.toBeNull()
    expect(key!.length).toBeGreaterThan(0)
    // 32 bytes → 44 base64 chars (with padding)
    expect(() => atob(key!)).not.toThrow()
  })

  // -------------------------------------------------------------------------
  // Test 7: publicKey is not in the persisted schema
  // -------------------------------------------------------------------------
  it('does not include publicKey in the persisted schema', () => {
    const schemaKeys = Object.keys(
      persistedStateSchema.shape.state.shape
    )
    expect(schemaKeys).not.toContain('publicKey')
    expect(schemaKeys).toEqual(
      expect.arrayContaining(['isConnected', 'address', 'network', 'connectedAt'])
    )
  })

  // -------------------------------------------------------------------------
  // Test 8: balance is not persisted
  // -------------------------------------------------------------------------
  it('does not persist balance in the encrypted payload', async () => {
    const value = {
      state: {
        isConnected: true,
        address: VALID_ADDRESS,
        network: 'testnet' as const,
        connectedAt: Date.now(),
      },
      version: 0,
    }

    await encryptedStorage.setItem!(STORAGE_KEY, value as any)
    await tick()

    const stored = localStorage.getItem(STORAGE_KEY)
    expect(stored).not.toBeNull()
    expect(stored).not.toContain('balance')

    // Verify the stored shape is { iv, ciphertext } only
    const blob = JSON.parse(stored!)
    expect(blob).toHaveProperty('iv')
    expect(blob).toHaveProperty('ciphertext')
    expect(Object.keys(blob)).toEqual(['iv', 'ciphertext'])
  })

  // -------------------------------------------------------------------------
  // Test 9: setWallet integration — round-trip encrypt/decrypt
  // -------------------------------------------------------------------------
  it('round-trips a wallet state through encrypt and decrypt', async () => {
    const payload = {
      state: {
        isConnected: true,
        address: VALID_ADDRESS,
        network: 'testnet' as const,
        connectedAt: Date.now(),
      },
      version: 0,
    }

    // Write
    await encryptedStorage.setItem!(STORAGE_KEY, payload as any)
    await tick()

    // Read back
    const result = await encryptedStorage.getItem!(STORAGE_KEY)
    expect(result).not.toBeNull()
    const st = result!.state as Record<string, unknown>
    expect(st).toMatchObject({
      isConnected: true,
      address: VALID_ADDRESS,
      network: 'testnet',
    })
    expect(typeof st.connectedAt).toBe('number')
    expect(result!.version).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Test 10: Zod strict mode rejects unknown keys
  // -------------------------------------------------------------------------
  it('rejects persisted state with unknown keys', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

    // Write a payload that includes an extra key
    await encryptedStorage.setItem!(STORAGE_KEY, {
      state: {
        isConnected: true,
        address: VALID_ADDRESS,
        network: 'testnet',
        connectedAt: Date.now(),
        publicKey: VALID_ADDRESS, // extra key not in schema
      },
      version: 0,
    } as any)
    await tick()

    const result = await encryptedStorage.getItem!(STORAGE_KEY)
    expect(result).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
  })
})
