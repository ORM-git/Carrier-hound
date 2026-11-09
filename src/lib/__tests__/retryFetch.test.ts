import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fetchWithRetry, isTransientStatus } from "../api/retryFetch";

const res = (status: number) => new Response(null, { status });
const noSleep = () => vi.fn(async () => {});

describe("fetchWithRetry", () => {
  it("returns first success without sleeping", async () => {
    const sleep = noSleep();
    const f = vi.fn(async () => res(200));
    const r = await fetchWithRetry(f, { sleep });
    expect(r.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
  it("retries 503 then succeeds", async () => {
    const sleep = noSleep();
    const f = vi.fn().mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200));
    const r = await fetchWithRetry(f, { sleep });
    expect(r.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
  it("retries a network error then succeeds", async () => {
    const f = vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(res(200));
    const r = await fetchWithRetry(f, { sleep: noSleep() });
    expect(r.status).toBe(200);
  });
  it("never retries 429, 4xx or 500", async () => {
    for (const s of [429, 400, 401, 404, 500]) {
      const f = vi.fn(async () => res(s));
      const r = await fetchWithRetry(f, { sleep: noSleep() });
      expect(r.status).toBe(s);
      expect(f).toHaveBeenCalledTimes(1);
    }
  });
  it("returns the last transient Response after retries are used up", async () => {
    const f = vi.fn(async () => res(502));
    const r = await fetchWithRetry(f, { retries: 2, sleep: noSleep() });
    expect(r.status).toBe(502);
    expect(f).toHaveBeenCalledTimes(3);
  });
  it("rethrows the last network error after retries are used up", async () => {
    const f = vi.fn(async () => { throw new TypeError("offline"); });
    await expect(fetchWithRetry(f, { retries: 1, sleep: noSleep() })).rejects.toThrow("offline");
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("backs off exponentially with jitter inside the bounds and respects maxMs", async () => {
    const waits: number[] = [];
    const f = vi.fn(async () => res(503));
    await fetchWithRetry(f, { retries: 3, baseMs: 300, maxMs: 700, rand: () => 0.5, sleep: async (ms) => { waits.push(ms); } });
    // rand 0.5 => jitter factor 1.0 => exact base waits: 300, 600, min(700, 1200)
    expect(waits).toEqual([300, 600, 700]);
  });
  it("retries 0 means a single attempt", async () => {
    const f = vi.fn(async () => res(503));
    const r = await fetchWithRetry(f, { retries: 0, sleep: noSleep() });
    expect(r.status).toBe(503);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("only 502/503/504 are transient", () => {
    expect([500, 502, 503, 504, 429].map(isTransientStatus)).toEqual([false, true, true, true, false]);
  });
});

describe("wiring", () => {
  it("stats fetch goes through fetchWithRetry and nothing else is wired", () => {
    const src = fs.readFileSync(path.join(__dirname, "../api/stats.ts"), "utf8");
    expect(src).toContain('import { fetchWithRetry } from "./retryFetch";');
    expect(src).toContain('fetchWithRetry(() => fetch("/api/stats", { headers }))');
    expect(src).not.toMatch(/[^.\w]fetch\("\/api\/stats", \{ headers \}\);/);
  });
});
