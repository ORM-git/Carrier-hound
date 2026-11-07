import { describe, it, expect, beforeEach } from "vitest";
import { LruCache } from "../cache/lru";
import {
  storeIdempotentResult,
  getIdempotentResult,
  _clearIdempotencyResultCacheForTesting,
} from "../ai/idempotency";

describe("LruCache memory bounds", () => {
  it("never exceeds its capacity", () => {
    const cache = new LruCache<string, number>(3);
    for (let i = 0; i < 100; i++) cache.set(`k${i}`, i);
    expect(cache.size).toBe(3);
  });

  it("evicts the oldest entry first", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  it("promotes reads so a hot key survives eviction", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeUndefined();
  });

  it("rejects a non-positive capacity", () => {
    expect(() => new LruCache(0)).toThrow(RangeError);
    expect(() => new LruCache(1.5)).toThrow(RangeError);
  });
});

describe("AI idempotency result cache memory bounds", () => {
  beforeEach(() => _clearIdempotencyResultCacheForTesting());

  it("stays capped at 10,001 entries under sustained writes", () => {
    for (let i = 0; i < 12000; i++) {
      storeIdempotentResult(`user-${i}`, "cover_letter", `key-${i}`, { i });
    }
    let size = 0;
    for (let i = 0; i < 12000; i++) {
      if (getIdempotentResult(`user-${i}`, "cover_letter", `key-${i}`) !== null) size++;
    }
    expect(size).toBeLessThanOrEqual(10001);
    expect(size).toBeGreaterThan(9000);
  });

  it("evicts oldest-first so the newest writes survive", () => {
    for (let i = 0; i < 11000; i++) {
      storeIdempotentResult("u", "cover_letter", `key-${i}`, { i });
    }
    expect(getIdempotentResult("u", "cover_letter", "key-10999")).toEqual({ i: 10999 });
    expect(getIdempotentResult("u", "cover_letter", "key-0")).toBeNull();
  });

  it("expires entries past the 24h TTL", () => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      storeIdempotentResult("u", "cover_letter", "ttl-key", { ok: true });
      expect(getIdempotentResult("u", "cover_letter", "ttl-key")).toEqual({ ok: true });
      now += 24 * 60 * 60 * 1000 + 1;
      expect(getIdempotentResult("u", "cover_letter", "ttl-key")).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });
});

describe("fallback rate-limit store key cap (rank 47)", () => {
  it("caps distinct keys and evicts expired windows first", async () => {
    const { checkRateLimit, FALLBACK_RATE_LIMIT_MAX_KEYS } = await import("@/lib/ai/serviceHandler");
    const store = new Map<string, { count: number; resetAt: number }>();
    const now = Date.now();
    // Fill to cap: one live window, the rest already expired.
    store.set("live-key", { count: 1, resetAt: now + 60000 });
    for (let i = 0; i < FALLBACK_RATE_LIMIT_MAX_KEYS - 1; i++) {
      store.set(`stale-${i}`, { count: 5, resetAt: now - 1000 });
    }
    expect(store.size).toBe(FALLBACK_RATE_LIMIT_MAX_KEYS);
    const r = checkRateLimit("brand-new-key", store, 10, 60000);
    expect(r.allowed).toBe(true);
    // Expired windows were dropped to make room; the live one survived.
    expect(store.size).toBeLessThan(FALLBACK_RATE_LIMIT_MAX_KEYS);
    expect(store.get("live-key")).toBeDefined();
    expect(store.get("brand-new-key")).toBeDefined();
  });

  it("evicts the soonest-expiring live window when nothing is expired", async () => {
    const { checkRateLimit, FALLBACK_RATE_LIMIT_MAX_KEYS } = await import("@/lib/ai/serviceHandler");
    const store = new Map<string, { count: number; resetAt: number }>();
    const now = Date.now();
    store.set("soonest", { count: 1, resetAt: now + 1000 });
    for (let i = 0; i < FALLBACK_RATE_LIMIT_MAX_KEYS - 1; i++) {
      store.set(`other-${i}`, { count: 1, resetAt: now + 60000 });
    }
    checkRateLimit("brand-new-key", store, 10, 60000);
    expect(store.size).toBe(FALLBACK_RATE_LIMIT_MAX_KEYS);
    expect(store.get("soonest")).toBeUndefined();
    expect(store.get("brand-new-key")).toBeDefined();
  });

  it("never touches existing keys below the cap", async () => {
    const { checkRateLimit } = await import("@/lib/ai/serviceHandler");
    const store = new Map<string, { count: number; resetAt: number }>();
    checkRateLimit("a", store, 2, 60000);
    checkRateLimit("b", store, 2, 60000);
    const r = checkRateLimit("a", store, 2, 60000);
    expect(r.currentCount).toBe(2);
    expect(store.size).toBe(2);
  });
});
