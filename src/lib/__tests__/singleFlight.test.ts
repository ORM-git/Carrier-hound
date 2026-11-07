import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { singleFlight, singleFlightPending } from "@/lib/cache/singleFlight";

// BE sheet rank 78 (cache stampede / request coalescing).

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("singleFlight", () => {
  it("runs the loader once for concurrent callers on the same key", async () => {
    const d = deferred<number>();
    let calls = 0;
    const loader = () => {
      calls++;
      return d.promise;
    };
    const ps: Promise<number>[] = [];
    for (let i = 0; i < 25; i++) ps.push(singleFlight("same", loader));
    expect(calls).toBe(1);
    expect(singleFlightPending()).toBe(1);
    d.resolve(42);
    const out = await Promise.all(ps);
    out.forEach((v) => expect(v).toBe(42));
    expect(singleFlightPending()).toBe(0);
  });

  it("does not coalesce different keys", async () => {
    let calls = 0;
    const a = deferred<string>();
    const b = deferred<string>();
    const pa = singleFlight("k-a", () => (calls++, a.promise));
    const pb = singleFlight("k-b", () => (calls++, b.promise));
    expect(calls).toBe(2);
    a.resolve("a");
    b.resolve("b");
    expect(await pa).toBe("a");
    expect(await pb).toBe("b");
  });

  it("starts a fresh loader after a settled load (not a cache)", async () => {
    let calls = 0;
    const loader = async () => ++calls;
    expect(await singleFlight("fresh", loader)).toBe(1);
    expect(await singleFlight("fresh", loader)).toBe(2);
  });

  it("propagates a rejection to every coalesced caller and never caches it", async () => {
    const d = deferred<number>();
    let calls = 0;
    const loader = () => {
      calls++;
      return d.promise;
    };
    const p1 = singleFlight("boom", loader);
    const p2 = singleFlight("boom", loader);
    const r1 = p1.then(() => "ok", (e: Error) => e.message);
    const r2 = p2.then(() => "ok", (e: Error) => e.message);
    d.reject(new Error("db down"));
    expect(await r1).toBe("db down");
    expect(await r2).toBe("db down");
    expect(calls).toBe(1);
    expect(singleFlightPending()).toBe(0);
    // next caller retries
    expect(await singleFlight("boom", async () => 7)).toBe(7);
  });

  it("turns a synchronous loader throw into a rejection and leaves nothing pending", async () => {
    const before = singleFlightPending();
    await expect(
      singleFlight("sync-throw", () => {
        throw new Error("sync");
      })
    ).rejects.toThrow("sync");
    expect(singleFlightPending()).toBe(before);
  });
});

describe("singleFlight adoption on the shared TTL-miss paths", () => {
  const ROOT = join(__dirname, "..", "..", "..");
  const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

  it("getAllActiveJobs coalesces its cache-miss load and keeps the TTL fast path", () => {
    const src = read("src/lib/jobs/service.ts");
    expect(src).toContain('import { singleFlight } from "@/lib/cache/singleFlight";');
    expect(src).toContain('return singleFlight("jobs:getAllActiveJobs", loadAllActiveJobs);');
    const a = src.indexOf("export async function getAllActiveJobs");
    const b = src.indexOf("async function loadAllActiveJobs");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    const wrapper = src.slice(a, b);
    expect(wrapper).toContain("cachedAllActiveJobs && now - cacheTimestamp < CACHE_TTL_MS");
    // the loader still owns the cache write
    const loader = src.slice(b, b + 4000);
    expect(loader).toContain("cachedAllActiveJobs = mapped;");
  });

  it("radar GET coalesces the aggregation and each caller still builds its own response", () => {
    const src = read("src/app/api/radar/route.ts");
    expect(src).toContain('import { singleFlight } from "@/lib/cache/singleFlight";');
    expect(src).toContain('await singleFlight("radar:aggregate", () => computeRadarPayload(supabase, now))');
    const get = src.slice(src.indexOf("export async function GET"));
    // HIT path, MISS path and the 500 catch stay in GET
    expect(get).toContain("'X-Cache': 'HIT'");
    expect(get).toContain("'X-Cache': 'MISS'");
    expect(get).toContain("{ status: 500 }");
    // the aggregation (and its memoryCache write) lives in the coalesced function
    const compute = src.slice(
      src.indexOf("async function computeRadarPayload"),
      src.indexOf("export async function GET")
    );
    expect(compute).toContain("memoryCache = {");
    expect(compute).toContain("from('ingest_runs')");
  });
});
