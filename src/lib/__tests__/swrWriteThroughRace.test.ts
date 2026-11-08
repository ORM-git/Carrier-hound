import { afterEach, describe, expect, it, vi } from "vitest";
import { invalidateSwr, readSwr, swrFetch, updateSwr, isSwrStale } from "../cache/swr";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
afterEach(() => { invalidateSwr(""); vi.useRealTimers(); });
describe("SWR write-through versus older revalidation", () => {
  it("preserves the mutation value and original age when an old read settles", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    await swrFetch("race:key", async () => 1);
    vi.setSystemTime(3000);
    const old = deferred<number>();
    const waiting = swrFetch("race:key", () => old.promise, 0);
    updateSwr<number>("race:key", () => 2);
    old.resolve(1);
    expect(await waiting).toBe(1); // Not a cancellation API.
    expect(readSwr("race:key")).toBe(2);
    expect(isSwrStale("race:key", 1000)).toBe(true);
  });
  it.each(["resolve", "reject"] as const)("old %s cannot remove a newer dedupe slot after write-through", async (outcome) => {
    await swrFetch("race:key", async () => 1);
    const old = deferred<number>(); const newer = deferred<number>();
    const handled = swrFetch("race:key", () => old.promise, 0).catch(() => -1);
    updateSwr<number>("race:key", () => 2);
    const loader = vi.fn(() => newer.promise);
    const next = swrFetch("race:key", loader, 0);
    if (outcome === "resolve") old.resolve(1); else old.reject(new Error("old failure"));
    await handled;
    const joined = swrFetch("race:key", loader, 0);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(readSwr("race:key")).toBe(2);
    newer.resolve(3); await Promise.all([next, joined]);
    expect(readSwr("race:key")).toBe(3);
  });
  it("does not detach a pending-only key for the documented missing-entry no-op", async () => {
    const pending = deferred<number>(); const loader = vi.fn(() => pending.promise);
    const waiting = swrFetch("race:key", loader);
    const updater = vi.fn(() => 2);
    updateSwr("race:key", updater);
    const joined = swrFetch("race:key", loader);
    expect(updater).not.toHaveBeenCalled(); expect(loader).toHaveBeenCalledTimes(1);
    pending.resolve(1); await Promise.all([waiting, joined]);
    expect(readSwr("race:key")).toBe(1);
  });
  it("does not change the entry or detach a pending read when the updater throws", async () => {
    await swrFetch("race:key", async () => 1);
    const pending = deferred<number>(); const loader = vi.fn(() => pending.promise);
    const waiting = swrFetch("race:key", loader, 0);
    const error = new Error("mutation failed");
    expect(() => updateSwr("race:key", () => { throw error; })).toThrow(error);
    expect(readSwr("race:key")).toBe(1);
    const joined = swrFetch("race:key", loader, 0);
    expect(loader).toHaveBeenCalledTimes(1);
    pending.resolve(3); await Promise.all([waiting, joined]);
    expect(readSwr("race:key")).toBe(3);
  });
});
