import { describe, it, expect } from "vitest";
import {
  isLockedOut,
  recordFailureAndMaybeLock,
  LOCKOUT_STEPS,
} from "@/lib/security/progressiveLockout";

// Backend sheet rank 68 (Brute-force Lockout): progressive app-level
// lockout on the shared store. The in-memory fake mirrors migration
// 20261020: check_rate_limit is an unconditional atomic increment;
// peekSharedRateLimitCount is a plain SELECT (read-only, expired rows
// read as 0). The regression pinned below: before the fix, isLockedOut
// used the incrementing check, so the 9th request in 10 minutes locked
// the admin even with ZERO failures.

type Row = { count: number; expiresAt: number };
function fakeStore(nowMs = 0) {
  const rows = new Map<string, Row>();
  let writes = 0;
  const check = async (key: string, max: number, windowSeconds: number) => {
    writes += 1;
    const now = nowMs;
    let row = rows.get(key);
    if (!row || row.expiresAt <= now) {
      row = { count: 0, expiresAt: now + windowSeconds * 1000 };
      rows.set(key, row);
    }
    row.count += 1;
    const allowed = row.count <= max;
    return {
      allowed,
      retryAfter: allowed ? 0 : Math.max(1, Math.round((row.expiresAt - now) / 1000)),
      currentCount: row.count,
      source: "shared" as const,
    };
  };
  const peek = async (key: string) => {
    const row = rows.get(key);
    if (!row) return { count: 0, expiresAt: null, source: "shared" as const };
    if (row.expiresAt <= nowMs) {
      return { count: 0, expiresAt: new Date(row.expiresAt).toISOString(), source: "shared" as const };
    }
    return { count: row.count, expiresAt: new Date(row.expiresAt).toISOString(), source: "shared" as const };
  };
  return { rows, check, peek, getWrites: () => writes };
}

const SOFT = LOCKOUT_STEPS[0];

describe("recordFailureAndMaybeLock", () => {
  it("does not lock below the soft threshold", async () => {
    const { check } = fakeStore();
    for (let i = 0; i < SOFT.failures - 1; i++) {
      const r = await recordFailureAndMaybeLock("admin", "1.2.3.4", { check });
      expect(r.locked).toBe(false);
    }
  });

  it("locks once the soft threshold is exceeded", async () => {
    const { check } = fakeStore();
    let last = { locked: false } as any;
    for (let i = 0; i < SOFT.failures + 1; i++) {
      last = await recordFailureAndMaybeLock("admin", "9.9.9.9", { check });
    }
    expect(last.locked).toBe(true);
    expect(last.step).toEqual(SOFT);
  });

  it("scopes counters per identifier", async () => {
    const { check, peek } = fakeStore();
    for (let i = 0; i < SOFT.failures + 1; i++) {
      await recordFailureAndMaybeLock("admin", "8.8.8.8", { check });
    }
    expect((await isLockedOut("admin", "8.8.8.8", { peek })).locked).toBe(true);
    expect((await isLockedOut("admin", "7.7.7.7", { peek })).locked).toBe(false);
  });
});

describe("isLockedOut", () => {
  it("is read-only: many successful verifications never lock and never increment", async () => {
    // Regression: verifyAdminSession calls isLockedOut on EVERY request.
    // N >> soft threshold (8) successful checks must not lock and must
    // not touch the counters.
    const store = fakeStore();
    for (let i = 0; i < 100; i++) {
      const r = await isLockedOut("admin", "3.3.3.3", { peek: store.peek });
      expect(r.locked).toBe(false);
    }
    expect(store.getWrites()).toBe(0);
    expect(store.rows.size).toBe(0);
  });

  it("confirms a lock set by failures and reports the longest tripped step", async () => {
    const { check, peek } = fakeStore();
    const long = LOCKOUT_STEPS[LOCKOUT_STEPS.length - 1];
    for (let i = 0; i < long.failures + 1; i++) {
      await recordFailureAndMaybeLock("admin", "5.5.5.5", { check });
    }
    const status = await isLockedOut("admin", "5.5.5.5", { peek });
    expect(status.locked).toBe(true);
    expect(status.step).toEqual(long);
  });

  it("keeps counting checks after a lock invisible to the counters (no self-extension)", async () => {
    const { check, peek, getWrites } = fakeStore();
    for (let i = 0; i < SOFT.failures + 1; i++) {
      await recordFailureAndMaybeLock("admin", "4.4.4.4", { check });
    }
    expect((await isLockedOut("admin", "4.4.4.4", { peek })).locked).toBe(true);
    const writesBefore = getWrites();
    for (let i = 0; i < 50; i++) {
      expect((await isLockedOut("admin", "4.4.4.4", { peek })).locked).toBe(true);
    }
    expect(getWrites()).toBe(writesBefore);
  });

  it("fails open when the store is unavailable or errors", async () => {
    const down = async () => null;
    expect((await isLockedOut("admin", "1.1.1.1", { peek: down as any })).locked).toBe(false);
    const downCheck = async () => ({ allowed: true, retryAfter: 0, currentCount: 0, source: "unavailable" as const });
    expect((await recordFailureAndMaybeLock("admin", "1.1.1.1", { check: downCheck as any })).locked).toBe(false);
    const throwing = async () => { throw new Error("store down"); };
    expect((await isLockedOut("admin", "1.1.1.1", { peek: throwing as any })).locked).toBe(false);
    expect((await recordFailureAndMaybeLock("admin", "1.1.1.1", { check: throwing as any })).locked).toBe(false);
  });

  it("self-heals when the window expires", async () => {
    const { check, peek } = fakeStore();
    for (let i = 0; i < SOFT.failures + 1; i++) {
      await recordFailureAndMaybeLock("admin", "2.2.2.2", { check });
    }
    expect((await isLockedOut("admin", "2.2.2.2", { peek })).locked).toBe(true);
    // New store instance simulates post-expiry (window state gone).
    const fresh = fakeStore(SOFT.withinSeconds * 1000 + 1);
    expect((await isLockedOut("admin", "2.2.2.2", { peek: fresh.peek })).locked).toBe(false);
  });
});
