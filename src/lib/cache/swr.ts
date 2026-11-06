/**
 * Minimal stale-while-revalidate cache for client-side server-state fetches.
 *
 * - Memory-only (no persistence): nothing stale survives a full reload and no
 *   user data is written to storage.
 * - `readSwr` returns a cached value of any age for instant paint.
 * - `swrFetch` serves fresh entries (within ttlMs) without a network call,
 *   otherwise fetches, updates the cache, and dedupes identical concurrent
 *   requests through a shared in-flight promise.
 * - `invalidateSwr` drops entries by exact key or prefix after mutations.
 * - `isSwrStale` reports cache age so pages can revalidate on tab-visible.
 */

interface CacheEntry<T> {
  data: T;
  ts: number;
}

const store = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

export function readSwr<T>(key: string): T | undefined {
  const hit = store.get(key) as CacheEntry<T> | undefined;
  return hit?.data;
}

export async function swrFetch<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlMs = 60_000
): Promise<T> {
  const hit = store.get(key) as CacheEntry<T> | undefined;
  if (hit && Date.now() - hit.ts < ttlMs) {
    return hit.data;
  }

  let pending = inflight.get(key) as Promise<T> | undefined;
  if (!pending) {
    pending = fetcher()
      .then((data) => {
        store.set(key, { data, ts: Date.now() });
        inflight.delete(key);
        return data;
      })
      .catch((err: unknown) => {
        inflight.delete(key);
        throw err;
      });
    inflight.set(key, pending);
  }
  return pending;
}

/** True when the entry is missing or older than ttlMs. */
export function isSwrStale(key: string, ttlMs = 60_000): boolean {
  const hit = store.get(key) as CacheEntry<unknown> | undefined;
  return !hit || Date.now() - hit.ts >= ttlMs;
}

export function invalidateSwr(keyOrPrefix: string): void {
  if (store.delete(keyOrPrefix)) return;
  for (const key of Array.from(store.keys())) {
    if (key.startsWith(keyOrPrefix)) store.delete(key);
  }
}
