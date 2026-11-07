import { describe, it, expect } from "vitest";
import { readSwr, swrFetch, updateSwr, isSwrStale, invalidateSwr } from "../cache/swr";

describe("updateSwr write-through", () => {
  it("updates a cached entry in place and preserves its timestamp", async () => {
    const key = "test:update-in-place";
    await swrFetch(key, async () => ({ appsRes: [1, 2], other: "keep" }), 60_000);
    updateSwr(key, (b: { appsRes: number[]; other: string }) => ({ ...b, appsRes: [1, 2, 3] }));
    const hit = readSwr<{ appsRes: number[]; other: string }>(key);
    expect(hit?.appsRes).toEqual([1, 2, 3]);
    expect(hit?.other).toBe("keep");
    // Entry keeps its age: still fresh inside the TTL, no reset to now.
    expect(isSwrStale(key, 60_000)).toBe(false);
    invalidateSwr(key);
  });

  it("is a no-op for a missing key (no phantom cache entry created)", () => {
    const key = "test:update-missing";
    updateSwr(key, (b: unknown) => b);
    expect(readSwr(key)).toBeUndefined();
    expect(isSwrStale(key)).toBe(true);
  });
});
