import { describe, it, expect, beforeEach } from "vitest";
import {
  peekSharedRateLimitCount,
  _resetSharedPeekCircuitForTesting,
} from "@/lib/api/sharedRateLimit";

// Read-only peek used by the progressive-lockout check (rank 68 fix):
// a plain SELECT on public.rate_limits; absent or expired rows are a
// definitive 0; any failure is null so callers fail open.

function fakeClient(result: { data?: any; error?: any }) {
  const calls: any[] = [];
  return {
    calls,
    client: {
      from: (table: string) => {
        calls.push({ fn: "from", table });
        return {
          select: (cols: string) => {
            calls.push({ fn: "select", cols });
            return {
              eq: (col: string, val: string) => {
                calls.push({ fn: "eq", col, val });
                return { maybeSingle: async () => ({ data: result.data ?? null, error: result.error ?? null }) };
              },
            };
          },
        };
      },
    },
  };
}

describe("peekSharedRateLimitCount", () => {
  beforeEach(() => {
    _resetSharedPeekCircuitForTesting();
  });

  it("returns the live count for an unexpired row", async () => {
    const { client } = fakeClient({ data: { count: 7, expires_at: new Date(Date.now() + 60000).toISOString() } });
    const r = await peekSharedRateLimitCount("k", { client });
    expect(r).toMatchObject({ count: 7, source: "shared" });
  });

  it("reads an absent row as a definitive 0", async () => {
    const { client } = fakeClient({ data: null });
    const r = await peekSharedRateLimitCount("k", { client });
    expect(r).toEqual({ count: 0, expiresAt: null, source: "shared" });
  });

  it("reads an expired row as a definitive 0", async () => {
    const { client } = fakeClient({ data: { count: 99, expires_at: new Date(Date.now() - 1000).toISOString() } });
    const r = await peekSharedRateLimitCount("k", { client });
    expect(r?.count).toBe(0);
  });

  it("returns null on store errors and exceptions (fail open)", async () => {
    const errClient = fakeClient({ error: new Error("rls") }).client;
    expect(await peekSharedRateLimitCount("k", { client: errClient })).toBeNull();
    const throwing = { from: () => { throw new Error("down"); } };
    expect(await peekSharedRateLimitCount("k", { client: throwing })).toBeNull();
  });

  it("queries the real table with the real columns", async () => {
    const { client, calls } = fakeClient({ data: null });
    await peekSharedRateLimitCount("fail:admin:x:600", { client });
    expect(calls).toEqual([
      { fn: "from", table: "rate_limits" },
      { fn: "select", cols: "count, expires_at" },
      { fn: "eq", col: "key", val: "fail:admin:x:600" },
    ]);
  });

  it("opens a short circuit after a failure so later checks fail fast without hitting the store", async () => {
    const failing = fakeClient({ error: new Error("store down") });
    expect(await peekSharedRateLimitCount("k", { client: failing.client })).toBeNull();
    expect(failing.calls.length).toBeGreaterThan(0);
    failing.calls.length = 0;
    // Circuit open: no further store calls, still fail-open null.
    expect(await peekSharedRateLimitCount("k", { client: failing.client })).toBeNull();
    expect(failing.calls).toEqual([]);
    // A working client is also short-circuited while the circuit is open.
    const working = fakeClient({ data: { count: 3, expires_at: new Date(Date.now() + 60000).toISOString() } });
    expect(await peekSharedRateLimitCount("k", { client: working.client })).toBeNull();
    expect(working.calls).toEqual([]);
  });

  it("times out a hung store instead of stalling the request", async () => {
    const hanging = {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: () => new Promise(() => {}) }),
        }),
      }),
    };
    const start = Date.now();
    const r = await peekSharedRateLimitCount("k", { client: hanging, timeoutMs: 50 });
    expect(r).toBeNull();
    expect(Date.now() - start).toBeLessThan(1000);
    // The timeout opened the circuit as well.
    const { client, calls } = fakeClient({ data: null });
    expect(await peekSharedRateLimitCount("k", { client })).toBeNull();
    expect(calls).toEqual([]);
  });
});

