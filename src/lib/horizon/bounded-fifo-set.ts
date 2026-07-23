/**
 * O(1) bounded FIFO set: a circular buffer backed by a Set.
 * When full, the oldest key is evicted before inserting the new one.
 */
export class BoundedFifoSet {
  private readonly set = new Set<string>()
  private readonly buffer: Array<string | undefined>
  private head = 0
  private size = 0

  constructor(private readonly capacity: number) {
    if (capacity < 1) {
      throw new Error('BoundedFifoSet capacity must be >= 1')
    }
    this.buffer = new Array(capacity)
  }

  has(key: string): boolean {
    return this.set.has(key)
  }

  /** @returns true if the key was newly inserted */
  add(key: string): boolean {
    if (this.set.has(key)) {
      return false
    }

    if (this.size < this.capacity) {
      const index = (this.head + this.size) % this.capacity
      this.buffer[index] = key
      this.set.add(key)
      this.size += 1
      return true
    }

    const evicted = this.buffer[this.head]
    if (evicted !== undefined) {
      this.set.delete(evicted)
    }
    this.buffer[this.head] = key
    this.set.add(key)
    this.head = (this.head + 1) % this.capacity
    return true
  }

  get length(): number {
    return this.size
  }

  clear(): void {
    this.set.clear()
    this.buffer.fill(undefined)
    this.head = 0
    this.size = 0
  }
}
