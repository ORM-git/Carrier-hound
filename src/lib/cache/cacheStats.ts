/**
 * Row 73 cache observability: in-process outcome counters per cache name. Counts only: no keys, values or user
 * data are recorded. Memory only, per isolate/process, so it is a diagnostic of this instance, not a fleet total
 * and not proof of shared-cache capacity. Recording never throws and never changes a cache result.
 */
export type CacheOutcome = "hit" | "miss" | "noop" | "error" | "dedupe";
export type CacheCounts = Record<CacheOutcome, number>;

const counters = new Map<string, CacheCounts>();
/** Bounded: a runaway number of cache names must not grow memory. Extra names fold into "other". */
export const CACHE_STATS_MAX_NAMES = 32;

const empty = (): CacheCounts => ({ hit: 0, miss: 0, noop: 0, error: 0, dedupe: 0 });

export function recordCacheOutcome(name: string, outcome: CacheOutcome): void {
  try {
    let c = counters.get(name);
    if (!c) {
      if (counters.size >= CACHE_STATS_MAX_NAMES) name = "other";
      c = counters.get(name) ?? empty();
      counters.set(name, c);
    }
    c[outcome] += 1;
  } catch { /* observability must never affect a cache read */ }
}

export function readCacheStats(): Record<string, CacheCounts & { hitRatio: number | null }> {
  const out: Record<string, CacheCounts & { hitRatio: number | null }> = {};
  counters.forEach((c, name) => {
    const lookups = c.hit + c.miss;
    out[name] = { ...c, hitRatio: lookups ? Math.round((c.hit / lookups) * 1000) / 1000 : null };
  });
  return out;
}

export function resetCacheStatsForTests(): void {
  counters.clear();
}
