/**
 * Single-flight request coalescing for server-side TTL caches.
 *
 * When a TTL cache entry expires, every request that arrives before the
 * reload finishes would otherwise run its own loader (a cache stampede).
 * `singleFlight(key, loader)` makes concurrent callers for the same key share
 * ONE in-flight loader promise.
 *
 * Behavior contract:
 * - callers that arrive while a loader for `key` is pending get that same
 *   promise (the loader runs once);
 * - the entry is removed when the promise settles, success OR failure, so a
 *   failure is never cached and the next caller starts a fresh loader;
 * - a rejection reaches every coalesced caller (each handles it in its own
 *   try/catch exactly as before);
 * - different keys never coalesce;
 * - this is per isolate/process only and holds no data after settling (it is
 *   not a cache, it never extends a TTL).
 *
 * Zero dependencies; safe in the edge and Node runtimes.
 */

const inflight = new Map<string, Promise<unknown>>();

export function singleFlight<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  let pending: Promise<T>;
  try {
    pending = Promise.resolve(loader());
  } catch (err) {
    return Promise.reject(err);
  }
  const tracked = pending.then(
    (value) => {
      if (inflight.get(key) === tracked) inflight.delete(key);
      return value;
    },
    (err: unknown) => {
      if (inflight.get(key) === tracked) inflight.delete(key);
      throw err;
    }
  );
  inflight.set(key, tracked);
  return tracked;
}

/** Number of loaders currently in flight (test/diagnostic helper). */
export function singleFlightPending(): number {
  return inflight.size;
}
