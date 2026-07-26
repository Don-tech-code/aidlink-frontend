import { getOrSetCache, invalidateCache, __clearCache } from './ttl-cache'

describe('getOrSetCache', () => {
  beforeEach(() => {
    __clearCache()
  })

  it('calls the fetcher and caches the result on a miss', async () => {
    const fetcher = jest.fn().mockResolvedValue('value-1')

    const result = await getOrSetCache('key', 10_000, fetcher)

    expect(result).toMatchObject({ data: 'value-1', cacheHit: false })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('returns the cached value without calling the fetcher again within the TTL', async () => {
    const fetcher = jest.fn().mockResolvedValue('value-1')

    await getOrSetCache('key', 10_000, fetcher)
    const second = await getOrSetCache('key', 10_000, fetcher)

    expect(second).toMatchObject({ data: 'value-1', cacheHit: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('re-invokes the fetcher once the TTL has elapsed', async () => {
    const fetcher = jest.fn().mockResolvedValueOnce('value-1').mockResolvedValueOnce('value-2')
    const nowSpy = jest.spyOn(Date, 'now')

    nowSpy.mockReturnValue(1_000_000)
    await getOrSetCache('key', 10_000, fetcher)

    nowSpy.mockReturnValue(1_000_000 + 10_001)
    const result = await getOrSetCache('key', 10_000, fetcher)

    expect(result).toMatchObject({ data: 'value-2', cacheHit: false })
    expect(fetcher).toHaveBeenCalledTimes(2)

    nowSpy.mockRestore()
  })

  it('keeps separate cache entries for different keys', async () => {
    const fetcherA = jest.fn().mockResolvedValue('a')
    const fetcherB = jest.fn().mockResolvedValue('b')

    await getOrSetCache('key-a', 10_000, fetcherA)
    await getOrSetCache('key-b', 10_000, fetcherB)

    const resultA = await getOrSetCache('key-a', 10_000, fetcherA)
    const resultB = await getOrSetCache('key-b', 10_000, fetcherB)

    expect(resultA.data).toBe('a')
    expect(resultB.data).toBe('b')
    expect(fetcherA).toHaveBeenCalledTimes(1)
    expect(fetcherB).toHaveBeenCalledTimes(1)
  })

  it('invalidateCache forces the next call to re-fetch', async () => {
    const fetcher = jest.fn().mockResolvedValueOnce('value-1').mockResolvedValueOnce('value-2')

    await getOrSetCache('key', 10_000, fetcher)
    invalidateCache('key')
    const result = await getOrSetCache('key', 10_000, fetcher)

    expect(result).toMatchObject({ data: 'value-2', cacheHit: false })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('reports the remaining TTL via expiresInMs', async () => {
    const fetcher = jest.fn().mockResolvedValue('value-1')
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)

    const first = await getOrSetCache('key', 10_000, fetcher)
    expect(first.expiresInMs).toBe(10_000)

    nowSpy.mockReturnValue(1_000_000 + 4_000)
    const second = await getOrSetCache('key', 10_000, fetcher)
    expect(second.expiresInMs).toBe(6_000)

    nowSpy.mockRestore()
  })
})
