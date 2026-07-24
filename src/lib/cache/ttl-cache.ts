/**
 * Simple in-memory, short-TTL cache (issue #59). Deliberately not Redis or
 * any external cache store — "simple" per the issue title, and this app
 * has no distributed-cache infrastructure yet. This is a single Node
 * process's in-memory cache: correct and effective for a single server
 * instance (including a single serverless/edge instance's lifetime), but
 * won't be shared across multiple instances behind a load balancer — if
 * this app scales horizontally, a shared store (Redis, etc.) would be the
 * natural next step, sharing this same get-or-fetch interface.
 *
 * Deliberately generic so any other "list" endpoint (donations, analytics,
 * etc.) can reuse the same pattern rather than each hand-rolling its own
 * cache.
 */

interface CacheEntry<T> {
  data: T
  expiresAt: number
}

const store = new Map<string, CacheEntry<unknown>>()

export interface CachedResult<T> {
  data: T
  cacheHit: boolean
  /** Milliseconds until this entry expires, from the moment it was returned. */
  expiresInMs: number
}

/**
 * Returns the cached value for `key` if it's still within its TTL,
 * otherwise calls `fetcher()`, caches the result for `ttlMs`, and returns
 * that instead. Concurrent callers for the same stale/missing key will each
 * trigger their own `fetcher()` call (no in-flight de-duplication) — for a
 * "simple" cache with a short TTL and low expected concurrency this is an
 * acceptable tradeoff; de-duplicating concurrent misses would be the first
 * thing to add if this endpoint saw meaningfully higher traffic.
 */
export async function getOrSetCache<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<CachedResult<T>> {
  const now = Date.now()
  const existing = store.get(key) as CacheEntry<T> | undefined

  if (existing && existing.expiresAt > now) {
    return { data: existing.data, cacheHit: true, expiresInMs: existing.expiresAt - now }
  }

  const data = await fetcher()
  const expiresAt = now + ttlMs
  store.set(key, { data, expiresAt })

  return { data, cacheHit: false, expiresInMs: ttlMs }
}

/** Drops a single cache entry, forcing the next getOrSetCache() call for that key to re-fetch. */
export function invalidateCache(key: string): void {
  store.delete(key)
}

/** Test-only helper to reset all cache state between test cases. */
export function __clearCache(): void {
  store.clear()
}
