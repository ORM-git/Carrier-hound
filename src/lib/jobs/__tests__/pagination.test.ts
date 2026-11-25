import { describe, expect, it, vi } from "vitest";
import { appendPage, createNextPageLoader, isStalledCursor, PREFETCH_PAGES, refillTarget } from "../pagination";

// CM mobile item 21: behavior of next-page loading (dedupe, single flight, abort, stale responses, errors).
const j = (id: string) => ({ id });
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

describe("appendPage", () => {
  it("keeps server order and drops ids already shown", () => {
    expect(appendPage([j("a"), j("b")], [j("b"), j("c"), j("d")]).map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("drops duplicates inside the same incoming page (first occurrence wins)", () => {
    const first = { id: "x", n: 1 };
    const out = appendPage([j("a")], [first, j("y"), { id: "x", n: 2 }, j("y")]);
    expect(out.map((x) => x.id)).toEqual(["a", "x", "y"]);
    expect(out[1]).toBe(first);
  });

  it("returns a new array and leaves the previous list untouched", () => {
    const prev = [j("a")];
    expect(appendPage(prev, [])).not.toBe(prev);
    expect(prev).toEqual([j("a")]);
  });
});

describe("createNextPageLoader", () => {
  it("allows one request at a time", async () => {
    const loader = createNextPageLoader<number>();
    const d = deferred<number>();
    const run = vi.fn(() => d.promise);
    const apply = vi.fn();
    const first = loader.load(run, apply);
    expect(loader.busy).toBe(true);
    expect(await loader.load(run, apply)).toBe("busy");
    expect(run).toHaveBeenCalledTimes(1);
    d.resolve(2);
    expect(await first).toBe("applied");
    expect(apply).toHaveBeenCalledWith(2);
    expect(loader.busy).toBe(false);
  });

  it("reset() aborts the in-flight request and a late response is never applied (race)", async () => {
    const loader = createNextPageLoader<string>();
    const d = deferred<string>();
    let signal!: AbortSignal;
    const apply = vi.fn();
    const pending = loader.load((s) => ((signal = s), d.promise), apply);
    loader.reset(); // filters/tab/search changed
    expect(signal.aborted).toBe(true);
    expect(loader.busy).toBe(false);
    d.resolve("old query page 2"); // server ignored the abort and answered anyway
    expect(await pending).toBe("stale");
    expect(apply).not.toHaveBeenCalled();
  });

  it("an abort rejection after reset is stale, not an error", async () => {
    const loader = createNextPageLoader<string>();
    const pending = loader.load(
      (s) => new Promise<string>((_, reject) => s.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
      vi.fn()
    );
    loader.reset();
    expect(await pending).toBe("stale");
  });

  it("after reset the new query can load immediately, and the old response cannot overwrite it", async () => {
    const loader = createNextPageLoader<string>();
    const old = deferred<string>();
    const applied: string[] = [];
    const stale = loader.load(() => old.promise, (r) => applied.push(r));
    loader.reset();
    expect(await loader.load(async () => "new query page 2", (r) => applied.push(r))).toBe("applied");
    old.resolve("old query page 2");
    expect(await stale).toBe("stale");
    expect(applied).toEqual(["new query page 2"]);
  });

  it("a failed request reports error, frees the loader, and a retry succeeds", async () => {
    const loader = createNextPageLoader<number>();
    expect(await loader.load(() => Promise.reject(new Error("500")), vi.fn())).toBe("error");
    expect(loader.busy).toBe(false);
    const apply = vi.fn();
    expect(await loader.load(async () => 3, apply)).toBe("applied");
    expect(apply).toHaveBeenCalledWith(3);
  });
});

describe("refillTarget (bounded three-page look-ahead)", () => {
  it("refills the next three pages only while fewer than three are buffered past the reader", () => {
    expect(PREFETCH_PAGES).toBe(3);
    expect(refillTarget(3, 2)).toBe(6); // reader enters page 2 with pages 1-3 loaded
    expect(refillTarget(6, 3)).toBeNull(); // three pages already ahead: nothing to fetch
    expect(refillTarget(6, 4)).toBe(9);
    expect(refillTarget(6, 6)).toBe(9); // reader reached the tail
  });

  it("never lets the window exceed five pages ahead, whatever page is reached", () => {
    for (let loaded = 1; loaded < 40; loaded++) {
      for (let reached = 1; reached <= loaded; reached++) {
        const target = refillTarget(loaded, reached);
        if (target !== null) expect(target - reached).toBeLessThanOrEqual(2 * PREFETCH_PAGES - 1);
      }
    }
  });
});

describe("isStalledCursor", () => {
  const seen = new Set(["c1", "c2"]);
  it("page-numbered streams and true ends always progress", () => {
    expect(isStalledCursor(null, { hasNextPage: true, nextCursor: null }, seen)).toBe(false);
    expect(isStalledCursor("c2", { hasNextPage: false, nextCursor: null }, seen)).toBe(false);
  });
  it("a fresh cursor progresses", () => {
    expect(isStalledCursor("c2", { hasNextPage: true, nextCursor: "c3" }, seen)).toBe(false);
  });
  it("a repeated or already-consumed cursor stalls", () => {
    expect(isStalledCursor("c3", { hasNextPage: true, nextCursor: "c3" }, new Set())).toBe(true);
    expect(isStalledCursor("c2", { hasNextPage: true, nextCursor: "c1" }, seen)).toBe(true);
  });
  it("a cursor stream that drops its cursor while reporting more stalls", () => {
    expect(isStalledCursor("c2", { hasNextPage: true, nextCursor: null }, seen)).toBe(true);
  });
});
