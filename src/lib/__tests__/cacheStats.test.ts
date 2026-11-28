import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CACHE_STATS_MAX_NAMES, readCacheStats, recordCacheOutcome, resetCacheStatsForTests } from "@/lib/cache/cacheStats";
import { getRedis, resetRedisForTests } from "@/lib/cache/redis";
import { invalidateSwr, swrFetch } from "@/lib/cache/swr";

beforeEach(() => { resetCacheStatsForTests(); resetRedisForTests(); invalidateSwr("t:"); });
afterEach(() => { resetCacheStatsForTests(); });

describe("cache outcome counters (row 73)", () => {
  it("swr: first call is a miss, a fresh repeat is a hit, a concurrent call dedupes", async () => {
    let resolve!: (v: number) => void;
    const slow = () => new Promise<number>((r) => { resolve = r; });
    const a = swrFetch("t:one", slow, 60_000);
    const b = swrFetch("t:one", slow, 60_000);
    resolve(1);
    await Promise.all([a, b]);
    await swrFetch("t:one", async () => 2, 60_000);
    const s = readCacheStats().swr;
    expect(s.miss).toBe(1);
    expect(s.dedupe).toBe(1);
    expect(s.hit).toBe(1);
    expect(s.hitRatio).toBe(0.5);
  });

  it("redis noop adapter: reads count as noop, not as misses, and still return null", async () => {
    const r = getRedis({ url: "", token: "" });
    expect(r.isEnabled()).toBe(false);
    expect(await r.get("k")).toBeNull();
    const s = readCacheStats().redis;
    expect(s.noop).toBe(1);
    expect(s.miss).toBe(0);
  });

  it("redis enabled adapter: hit, miss and error are told apart, results unchanged", async () => {
    const replies: Array<() => Response> = [
      () => new Response(JSON.stringify({ result: "v" }), { status: 200 }),
      () => new Response(JSON.stringify({ result: null }), { status: 200 }),
      () => new Response("no", { status: 500 }),
    ];
    const r = getRedis({ url: "https://r.example.invalid", token: "t", fetchImpl: async () => replies.shift()!() });
    expect(await r.get("a")).toBe("v");
    expect(await r.get("b")).toBeNull();
    expect(await r.get("c")).toBeNull();
    const s = readCacheStats().redis;
    expect([s.hit, s.miss, s.error, s.noop]).toEqual([1, 1, 1, 0]);
  });

  it("records no keys or values, only counts", () => {
    recordCacheOutcome("swr", "hit");
    expect(JSON.stringify(readCacheStats())).not.toMatch(/secret|token|key/i);
  });

  it("is bounded: names beyond the cap fold into other, and recording never throws", () => {
    for (let i = 0; i < CACHE_STATS_MAX_NAMES + 5; i++) recordCacheOutcome(`n${i}`, "hit");
    const stats = readCacheStats();
    expect(Object.keys(stats).length).toBeLessThanOrEqual(CACHE_STATS_MAX_NAMES + 1);
    expect(stats.other.hit).toBe(5);
    expect(() => recordCacheOutcome("x", "bogus" as any)).not.toThrow();
  });
});
