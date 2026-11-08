import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lastRequestByDomain, throttleDomain } from "../../../scripts/utils/polite-fetch";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  lastRequestByDomain.clear();
});
afterEach(async () => {
  await vi.runAllTimersAsync();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("per-domain request-start pacing", () => {
  it("serializes simultaneous callers from different subdomains in FIFO order", async () => {
    const starts: Array<[number, number]> = [];
    const calls = ["a.lever.co", "b.lever.co", "api.lever.co"].map((host, index) =>
      throttleDomain(host, 1000).then(() => { starts.push([index, Date.now()]); }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([[0, 100_000]]);
    await vi.advanceTimersByTimeAsync(999);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([[0, 100_000], [1, 101_000]]);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(calls);
    expect(starts).toEqual([[0, 100_000], [1, 101_000], [2, 102_000]]);
  });
  it("does not block another registrable domain behind a queued request", async () => {
    await throttleDomain("api.lever.co", 1000);
    let queued = false;
    const pending = throttleDomain("api.lever.co", 1000).then(() => { queued = true; });
    await throttleDomain("boards.greenhouse.io", 1000);
    expect(lastRequestByDomain.get("greenhouse.io")).toBe(100_000);
    expect(queued).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
  });
  it("pacing follows actual starts after a large scheduling delay", async () => {
    await throttleDomain("api.lever.co", 1000);
    const starts: number[] = [];
    const pending = [0, 1].map(() => throttleDomain("api.lever.co", 1000)
      .then(() => { starts.push(Date.now()); }));
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(200_000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(starts).toEqual([201_000]);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(pending);
    expect(starts).toEqual([201_000, 202_000]);
  });
  it("keeps the last start after an idle queue finishes", async () => {
    await throttleDomain("api.lever.co", 1000);
    await vi.advanceTimersByTimeAsync(500);
    let started = false;
    const next = throttleDomain("api.lever.co", 1000).then(() => { started = true; });
    await vi.advanceTimersByTimeAsync(499);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(started).toBe(true);
  });
  it("a failed wait does not poison later queued callers", async () => {
    await throttleDomain("api.lever.co", 1000);
    const realTimer = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementationOnce(() => {
      throw new Error("timer unavailable");
    });
    const failed = throttleDomain("api.lever.co", 1000);
    await expect(failed).rejects.toThrow("timer unavailable");
    vi.mocked(globalThis.setTimeout).mockImplementation(realTimer);
    const next = throttleDomain("api.lever.co", 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await next;
    expect(lastRequestByDomain.get("lever.co")).toBe(101_000);
  });
  it.each([NaN, Infinity, -1, 60_001])("rejects invalid interval %s before queuing", async (interval) => {
    await expect(throttleDomain("api.lever.co", interval)).rejects.toThrow("Invalid throttle interval");
    expect(lastRequestByDomain.size).toBe(0);
  });
  it("supports an explicit zero interval without inventing a wait", async () => {
    await Promise.all([throttleDomain("api.lever.co", 0), throttleDomain("api.lever.co", 0)]);
    expect(lastRequestByDomain.get("lever.co")).toBe(100_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
