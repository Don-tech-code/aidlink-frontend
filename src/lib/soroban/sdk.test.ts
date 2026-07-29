import {
  getSorobanSDK,
  invalidateSorobanSDK,
  sorobanSDK,
  SorobanSDK,
  __clearSorobanSDKCache,
} from './sdk'

describe('SorobanSDK factory/cache (issue #105)', () => {
  beforeEach(() => {
    __clearSorobanSDKCache()
  })

  it('returns the correct mainnet passphrase', () => {
    expect(getSorobanSDK('mainnet').networkPassphrase).toBe(
      'Public Global Stellar Network ; September 2015'
    )
  })

  it('returns the correct testnet passphrase', () => {
    expect(getSorobanSDK('testnet').networkPassphrase).toBe('Test SDF Network ; September 2015')
  })

  it('returns the correct futurenet passphrase', () => {
    expect(getSorobanSDK('futurenet').networkPassphrase).toBe(
      'Test SDF Future Network ; October 2022'
    )
  })

  it('caches instances per network (cache hit)', () => {
    const a = getSorobanSDK('testnet')
    const b = getSorobanSDK('testnet')
    expect(a).toBe(b)
  })

  it('creates distinct instances for distinct networks (cache miss)', () => {
    const testnetSdk = getSorobanSDK('testnet')
    const mainnetSdk = getSorobanSDK('mainnet')
    expect(testnetSdk).not.toBe(mainnetSdk)
    expect(testnetSdk.network).toBe('testnet')
    expect(mainnetSdk.network).toBe('mainnet')
  })

  it('invalidateSorobanSDK followed by getSorobanSDK creates a new instance', () => {
    const first = getSorobanSDK('testnet')
    invalidateSorobanSDK('testnet')
    const second = getSorobanSDK('testnet')
    expect(second).not.toBe(first)
  })

  it('keeps the deprecated sorobanSDK singleton export available and typed as SorobanSDK', () => {
    expect(sorobanSDK).toBeInstanceOf(SorobanSDK)
    expect(sorobanSDK.network).toBe('testnet')
  })

  it('getSorobanSDK is synchronous', () => {
    const result = getSorobanSDK('testnet')
    expect((result as unknown as { then?: unknown }).then).toBeUndefined()
    expect(result).toBeInstanceOf(SorobanSDK)
  })
})
