import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { LruCache } from "@/lib/cache/lru";

describe("bounded ingestion LRU", () => {
  it("promotes reads and evicts the least recently used entry", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1).set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    expect(cache.size).toBe(2);
  });
  it("promotes writes without growing on overwrite", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1).set("b", 2).set("a", 4).set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(4);
    expect(cache.size).toBe(2);
  });
  it("supports misses, deletion and clear", () => {
    const cache = new LruCache<string, number>(1);
    expect(cache.get("missing")).toBeUndefined();
    cache.set("a", 1);
    expect(cache.delete("a")).toBe(true);
    cache.set("b", 2);
    cache.clear();
    expect(cache.size).toBe(0);
  });
  it("rejects invalid capacities", () => {
    for (const capacity of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => new LruCache(capacity)).toThrow(RangeError);
    }
  });
  it("bounds high-cardinality inserts", () => {
    const cache = new LruCache<number, number>(3);
    for (let i = 0; i < 10000; i++) cache.set(i, i);
    expect(cache.size).toBe(3);
    expect(cache.get(0)).toBeUndefined();
    expect(cache.get(9999)).toBe(9999);
  });
  it("is wired into the actual company lookup cache", () => {
    const source = readFileSync("scripts/ingest.ts", "utf8");
    expect(source).toContain("const companyCache = new LruCache<string, string>(5000)");
    expect(source).not.toContain("const companyCache = new Map");
  });
});
