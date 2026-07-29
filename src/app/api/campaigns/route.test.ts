jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn((body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: {
        get: (name: string) => init?.headers?.[name] ?? null,
      },
      json: async () => body,
    })),
  },
}))

import { __clearCache } from '@/lib/cache/ttl-cache'

describe('GET /api/campaigns', () => {
  beforeEach(() => {
    __clearCache()
    jest.resetModules()
  })

  it('returns the campaign list with a 200 and X-Cache: MISS on the first request', async () => {
    const { GET } = await import('./route')
    const res = await GET()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(Array.isArray(body.campaigns)).toBe(true)
    expect(body.campaigns.length).toBeGreaterThan(0)
    expect(res.headers.get('X-Cache')).toBe('MISS')
  })

  it('returns X-Cache: HIT on a second request within the TTL', async () => {
    const { GET } = await import('./route')
    await GET()
    const res = await GET()

    expect(res.headers.get('X-Cache')).toBe('HIT')
  })

  it('sets a Cache-Control header with s-maxage bounded by the TTL', async () => {
    const { GET } = await import('./route')
    const res = await GET()

    const cacheControl = res.headers.get('Cache-Control')
    expect(cacheControl).toMatch(/s-maxage=\d+/)
    expect(cacheControl).toMatch(/stale-while-revalidate=\d+/)
  })
})
