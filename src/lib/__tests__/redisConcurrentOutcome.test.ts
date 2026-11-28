import { beforeEach, describe, expect, it } from "vitest";
import { getRedis } from "../cache/redis";
import { readCacheStats, resetCacheStatsForTests } from "../cache/cacheStats";

// Two concurrent GETs on ONE adapter: the failure of one call must not be counted against the other.
describe("Redis per-call outcome under concurrency", () => {
  beforeEach(() => resetCacheStatsForTests());

  it("one miss + one failure concurrently records exactly 1 miss and 1 error, in either completion order", async () => {
    for (const failFirst of [false, true]) {
      resetCacheStatsForTests();
      let n = 0;
      let releaseMiss!: () => void;
      const gate = new Promise<void>((r) => { releaseMiss = r; });
      const errors: unknown[] = [];
      const redis = getRedis({
        url: "https://cache.example.invalid", token: "t", onError: (e) => errors.push(e),
        fetchImpl: async () => {
          const i = n++;
          const isMiss = failFirst ? i === 1 : i === 0;
          if (isMiss) { await gate; return new Response(JSON.stringify({ result: null })); }
          throw new Error("network down");
        },
      });
      const a = redis.get("k1");
      const b = redis.get("k2");
      await new Promise((r) => setTimeout(r, 5)); // failing call settles first
      releaseMiss();
      expect(await Promise.all([a, b])).toEqual([null, null]);
      const s = readCacheStats().redis;
      expect({ miss: s.miss, error: s.error, hit: s.hit }).toEqual({ miss: 1, error: 1, hit: 0 });
      expect(errors).toHaveLength(1);
    }
  });

  it("a hit concurrent with a failure records 1 hit and 1 error", async () => {
    let n = 0;
    const redis = getRedis({
      url: "https://cache.example.invalid", token: "t", onError: () => {},
      fetchImpl: async () => { if (n++ === 0) return new Response(JSON.stringify({ result: "v" })); throw new Error("x"); },
    });
    const [a, b] = await Promise.all([redis.get("a"), redis.get("b")]);
    expect([a, b]).toEqual(["v", null]);
    const s = readCacheStats().redis;
    expect({ hit: s.hit, miss: s.miss, error: s.error }).toEqual({ hit: 1, miss: 0, error: 1 });
  });
});
