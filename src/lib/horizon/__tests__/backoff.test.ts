import { computeBackoffMs } from '../backoff'

describe('computeBackoffMs', () => {
  it('keeps attempt 0 near 1s within a ±50% band', () => {
    for (let i = 0; i < 20; i += 1) {
      const delay = computeBackoffMs(0, { random: () => i / 19 })
      expect(delay).toBeGreaterThanOrEqual(500)
      expect(delay).toBeLessThanOrEqual(1500)
    }
  })

  it('keeps attempt 1 near 2s within a ±50% band', () => {
    for (let i = 0; i < 20; i += 1) {
      const delay = computeBackoffMs(1, { random: () => i / 19 })
      expect(delay).toBeGreaterThanOrEqual(1000)
      expect(delay).toBeLessThanOrEqual(3000)
    }
  })

  it('keeps attempt 2 near 4s within a ±50% band', () => {
    for (let i = 0; i < 20; i += 1) {
      const delay = computeBackoffMs(2, { random: () => i / 19 })
      expect(delay).toBeGreaterThanOrEqual(2000)
      expect(delay).toBeLessThanOrEqual(6000)
    }
  })

  it('caps at maxDelay', () => {
    const delay = computeBackoffMs(20, {
      baseDelay: 1000,
      maxDelay: 60_000,
      random: () => 1,
    })
    expect(delay).toBeLessThanOrEqual(60_000)
  })
})
