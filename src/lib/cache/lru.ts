/** Bounded entry-count LRU. Reads/writes promote recency; eviction merely
 * drops an optimization, so callers must treat misses as normal. */
export class LruCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError("LRU capacity must be a positive safe integer");
    }
  }

  get size(): number { return this.entries.size; }

  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): this {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    return this;
  }

  delete(key: K): boolean { return this.entries.delete(key); }
  clear(): void { this.entries.clear(); }
}
