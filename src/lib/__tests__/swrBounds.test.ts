import { afterEach, describe, expect, it, vi } from "vitest";
import { invalidateSwr, isSwrStale, readSwr, SWR_MAX_ENTRIES, swrFetch, updateSwr } from "../cache/swr";

afterEach(() => { invalidateSwr(""); vi.useRealTimers(); });

describe("client SWR completed-value bounds", () => {
  it("retains at most 200 latest writes under a high-cardinality workload", async () => {
    invalidateSwr("");
    for (let i = 0; i < 600; i++) await swrFetch(`bounds:${i}`, async () => i);
    const retained = Array.from({ length: 600 }, (_, i) => readSwr(`bounds:${i}`))
      .filter((value) => value !== undefined);
    expect(retained).toHaveLength(SWR_MAX_ENTRIES);
    expect(retained[0]).toBe(400);
    expect(retained[199]).toBe(599);
    expect(isSwrStale("bounds:0")).toBe(true);
  });
  it("refetches an evicted key while a retained fresh key remains a cache hit", async () => {
    invalidateSwr("");
    await swrFetch("old", async () => "old");
    for (let i = 0; i < SWR_MAX_ENTRIES; i++) await swrFetch(`bounds:${i}`, async () => i);
    const hit = vi.fn(async () => "unexpected");
    expect(await swrFetch("bounds:199", hit)).toBe(199);
    expect(hit).not.toHaveBeenCalled();
    const reload = vi.fn(async () => "reloaded");
    expect(await swrFetch("old", reload)).toBe("reloaded");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(readSwr("bounds:0")).toBeUndefined();
  });
  it("updates write recency without resetting the original freshness timestamp", async () => {
    invalidateSwr(""); vi.useFakeTimers(); vi.setSystemTime(100_000);
    await swrFetch("old", async () => 1);
    for (let i = 0; i < SWR_MAX_ENTRIES - 1; i++) await swrFetch(`bounds:${i}`, async () => i);
    vi.setSystemTime(101_000);
    updateSwr<number>("old", (n) => n + 1);
    await swrFetch("new", async () => "new");
    expect(readSwr("old")).toBe(2);
    expect(readSwr("bounds:0")).toBeUndefined();
    expect(isSwrStale("old", 1000)).toBe(true);
  });
  it("keeps one fetch for a pending key despite completed-value eviction", async () => {
    invalidateSwr("");
    let resolve!: (value: number) => void;
    const fetcher = vi.fn(() => new Promise<number>((done) => { resolve = done; }));
    const first = swrFetch("pending", fetcher);
    for (let i = 0; i < SWR_MAX_ENTRIES + 2; i++) await swrFetch(`bounds:${i}`, async () => i);
    const second = swrFetch("pending", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolve(42);
    expect(await first).toBe(42); expect(await second).toBe(42);
    expect(readSwr("pending")).toBe(42);
  });
  it("preserves prefix invalidation and failed-fetch retry behavior", async () => {
    await swrFetch("prefix:a", async () => 1);
    await swrFetch("prefix:b", async () => 2);
    await swrFetch("other", async () => 3);
    invalidateSwr("prefix:");
    expect(readSwr("prefix:a")).toBeUndefined();
    expect(readSwr("prefix:b")).toBeUndefined();
    expect(readSwr("other")).toBe(3);
    await expect(swrFetch("failed", async () => { throw new Error("failure"); })).rejects.toThrow("failure");
    expect(readSwr("failed")).toBeUndefined();
    expect(await swrFetch("failed", async () => "recovered")).toBe("recovered");
  });
});
