export const DEFAULT_BASE_DELAY_MS = 1000
export const DEFAULT_MAX_DELAY_MS = 60_000

export interface BackoffOptions {
  baseDelay?: number
  maxDelay?: number
  /** Injected for deterministic tests. Defaults to Math.random. */
  random?: () => number
}

/**
 * Full-jitter exponential backoff within a ±50% band of `base * 2^attempt`.
 *
 * attempt 0 → ≈ 1000ms, attempt 1 → ≈ 2000ms, attempt 2 → ≈ 4000ms
 * (each within [0.5x, 1.5x], capped at maxDelay).
 */
export function computeBackoffMs(
  attempt: number,
  options: BackoffOptions = {}
): number {
  const baseDelay = options.baseDelay ?? DEFAULT_BASE_DELAY_MS
  const maxDelay = options.maxDelay ?? DEFAULT_MAX_DELAY_MS
  const random = options.random ?? Math.random

  const safeAttempt = Math.max(0, attempt)
  const exponential = Math.min(maxDelay, baseDelay * 2 ** safeAttempt)
  const min = exponential * 0.5
  const max = Math.min(maxDelay, exponential * 1.5)

  return min + random() * (max - min)
}
