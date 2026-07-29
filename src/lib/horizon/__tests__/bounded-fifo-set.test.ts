import { BoundedFifoSet } from '../bounded-fifo-set'

describe('BoundedFifoSet', () => {
  it('rejects duplicates and reports membership', () => {
    const set = new BoundedFifoSet(3)
    expect(set.add('a')).toBe(true)
    expect(set.add('a')).toBe(false)
    expect(set.has('a')).toBe(true)
    expect(set.length).toBe(1)
  })

  it('evicts the oldest entry in O(1) when full', () => {
    const set = new BoundedFifoSet(3)
    set.add('a')
    set.add('b')
    set.add('c')
    set.add('d')

    expect(set.length).toBe(3)
    expect(set.has('a')).toBe(false)
    expect(set.has('b')).toBe(true)
    expect(set.has('c')).toBe(true)
    expect(set.has('d')).toBe(true)
  })
})
