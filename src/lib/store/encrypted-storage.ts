import type { PersistStorage, StorageValue } from 'zustand/middleware'
import { z } from 'zod'

const SESSION_STORAGE_KEY = 'aidlink:wallet:sessionKey'

export const persistedStateSchema = z.object({
  state: z.object({
    isConnected: z.boolean(),
    address: z
      .string()
      .regex(/^G[A-Z2-7]{55}$/)
      .nullable(),
    network: z.enum(['mainnet', 'testnet', 'futurenet', 'standalone']),
    connectedAt: z.number().nullable(),
  }).strict(),
  version: z.number(),
}).strict()

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.document !== 'undefined'
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

function base64ToBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
}

function toBuffer(data: Uint8Array): BufferSource {
  return data as unknown as BufferSource
}

let cachedKey: CryptoKey | null = null

async function getSessionKey(): Promise<CryptoKey | null> {
  if (cachedKey) return cachedKey
  if (!isBrowser()) return null

  const keyBase64 = sessionStorage.getItem(SESSION_STORAGE_KEY)
  if (!keyBase64) return null

  try {
    const keyBytes = base64ToBytes(keyBase64)
    cachedKey = await crypto.subtle.importKey(
      'raw',
      toBuffer(keyBytes),
      'AES-GCM',
      false,
      ['encrypt', 'decrypt']
    )
    return cachedKey
  } catch {
    return null
  }
}

async function createSessionKey(): Promise<CryptoKey> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32))
  sessionStorage.setItem(SESSION_STORAGE_KEY, bytesToBase64(keyBytes))
  cachedKey = await crypto.subtle.importKey(
    'raw',
    toBuffer(keyBytes),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt']
  )
  return cachedKey
}

async function encrypt(
  plaintext: string,
  key: CryptoKey
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toBuffer(iv) },
    key,
    toBuffer(encoded)
  )
  return JSON.stringify({
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  })
}

async function decrypt(
  blob: string,
  key: CryptoKey
): Promise<string | null> {
  try {
    const { iv: ivB64, ciphertext: ctB64 } = JSON.parse(blob)
    const iv = base64ToBytes(ivB64)
    const ciphertext = base64ToBytes(ctB64)
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toBuffer(iv) },
      key,
      toBuffer(ciphertext)
    )
    return new TextDecoder().decode(decrypted)
  } catch {
    return null
  }
}

export function clearSessionKeyCache(): void {
  cachedKey = null
}

export const encryptedStorage: PersistStorage<unknown> = {
  async getItem(
    name: string
  ): Promise<StorageValue<unknown> | null> {
    if (!isBrowser()) return null

    const raw = localStorage.getItem(name)
    if (!raw) return null

    const key = await getSessionKey()
    if (!key) {
      localStorage.removeItem(name)
      return null
    }

    const decrypted = await decrypt(raw, key)
    if (decrypted === null) {
      console.warn(
        '[encrypted-storage] Decryption failed (possible tampering): AES-GCM auth tag mismatch'
      )
      localStorage.removeItem(name)
      return null
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(decrypted)
    } catch {
      localStorage.removeItem(name)
      return null
    }

    const result = persistedStateSchema.safeParse(parsed)
    if (!result.success) {
      console.warn(
        '[encrypted-storage] Persisted state validation failed (possible tampering):',
        result.error.issues
      )
      localStorage.removeItem(name)
      return null
    }

    return parsed as StorageValue<unknown>
  },

  async setItem(
    name: string,
    value: StorageValue<unknown>
  ): Promise<void> {
    if (!isBrowser()) return

    let key = await getSessionKey()
    if (!key) {
      key = await createSessionKey()
    }

    const json = JSON.stringify(value)
    const encrypted = await encrypt(json, key)
    localStorage.setItem(name, encrypted)
  },

  async removeItem(name: string): Promise<void> {
    if (!isBrowser()) return
    localStorage.removeItem(name)
  },
}
