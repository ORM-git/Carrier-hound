import { afterEach, describe, expect, it, vi } from "vitest";
import { invalidateSwr, readSwr, swrFetch } from "../cache/swr";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
afterEach(() => invalidateSwr(""));

describe("SWR invalidation while a loader is pending", () => {
  it("does not repopulate the cache after invalidating a pending-only key", async () => {
    const old = deferred<string>();
    const waiting = swrFetch("race:key", () => old.promise);
    invalidateSwr("race:key");
    old.resolve("stale");
    expect(await waiting).toBe("stale"); // Caller results are not cancelled.
    expect(readSwr("race:key")).toBeUndefined();
    expect(await swrFetch("race:key", async () => "fresh")).toBe("fresh");
  });
  it("does not overwrite a newer completed value when an older read settles last", async () => {
    const old = deferred<string>();
    const waiting = swrFetch("race:key", () => old.promise);
    invalidateSwr("race:key");
    await swrFetch("race:key", async () => "fresh");
    old.resolve("stale"); await waiting;
    expect(readSwr("race:key")).toBe("fresh");
  });
  it.each(["resolve", "reject"] as const)("old %s cannot remove a newer pending dedupe slot", async (outcome) => {
    const old = deferred<string>(); const fresh = deferred<string>();
    const waiting = swrFetch("race:key", () => old.promise);
    const handled = waiting.catch(() => "expected failure");
    invalidateSwr("race:key");
    const loader = vi.fn(() => fresh.promise);
    const next = swrFetch("race:key", loader);
    if (outcome === "resolve") old.resolve("stale");
    else old.reject(new Error("old failure"));
    await handled;
    const joined = swrFetch("race:key", loader);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(readSwr("race:key")).toBeUndefined();
    fresh.resolve("fresh");
    expect(await next).toBe("fresh"); expect(await joined).toBe("fresh");
    expect(readSwr("race:key")).toBe("fresh");
  });
  it("invalidates pending-only prefix keys without touching unrelated work", async () => {
    const a = deferred<string>(); const b = deferred<string>(); const other = deferred<string>();
    const first = swrFetch("race:a", () => a.promise);
    const second = swrFetch("race:b", () => b.promise);
    const third = swrFetch("other:key", () => other.promise);
    invalidateSwr("race:");
    a.resolve("a"); b.resolve("b"); other.resolve("other");
    await Promise.all([first, second, third]);
    expect(readSwr("race:a")).toBeUndefined(); expect(readSwr("race:b")).toBeUndefined();
    expect(readSwr("other:key")).toBe("other");
  });
  it("preserves exact-key precedence instead of deleting similarly prefixed keys", async () => {
    await swrFetch("race:key", async () => "cached");
    await swrFetch("race:key:child", async () => "child");
    const old = deferred<string>();
    const waiting = swrFetch("race:key", () => old.promise, 0);
    invalidateSwr("race:key");
    expect(readSwr("race:key:child")).toBe("child");
    old.resolve("stale"); await waiting;
    expect(readSwr("race:key")).toBeUndefined();
  });
  it("clears a mixture of cached and pending prefix keys", async () => {
    await swrFetch("race:a", async () => "cached");
    const old = deferred<string>(); const waiting = swrFetch("race:b", () => old.promise);
    invalidateSwr("race:"); old.resolve("stale"); await waiting;
    expect(readSwr("race:a")).toBeUndefined(); expect(readSwr("race:b")).toBeUndefined();
  });
});
