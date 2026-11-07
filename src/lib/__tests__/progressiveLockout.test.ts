import { describe, it, expect } from "vitest";
import {
  isLockedOut,
  recordFailureAndMaybeLock,
  LOCKOUT_STEPS,
} from "@/lib/security/progressiveLockout";

// Backend sheet rank 68 (Brute-force Lockout): progressive app-level
// lockout on the shared store. These tests use an in-memory fake that
// mirrors migration 20261020 check_rate_limit semantics: atomic increment,
// fixed expires_at within a live window, count > max => denied.

type Row = { count: number; expiresAt: number };
function fakeStore(nowMs = 0) {
  const rows = new Map<string, Row>();
  const check = async (key: string, max: number, windowSeconds: number) => {
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
  return { rows, check };
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
    const { check } = fakeStore();
    for (let i = 0; i < SOFT.failures + 1; i++) {
      await recordFailureAndMaybeLock("admin", "8.8.8.8", { check });
    }
    expect((await isLockedOut("admin", "8.8.8.8", { check })).locked).toBe(true);
    expect((await isLockedOut("admin", "7.7.7.7", { check })).locked).toBe(false);
  });
});

describe("isLockedOut", () => {
  it("confirms a lock set by failures and reports the longest tripped step", async () => {
    const { check } = fakeStore();
    const long = LOCKOUT_STEPS[LOCKOUT_STEPS.length - 1];
    for (let i = 0; i < long.failures + 1; i++) {
      await recordFailureAndMaybeLock("admin", "5.5.5.5", { check });
    }
    const status = await isLockedOut("admin", "5.5.5.5", { check });
    expect(status.locked).toBe(true);
    expect(status.step).toEqual(long);
  });

  it("fails open when the store is unavailable or errors", async () => {
    const down = async () => ({ allowed: true, retryAfter: 0, currentCount: 0, source: "unavailable" as const });
    expect((await isLockedOut("admin", "1.1.1.1", { check: down as any })).locked).toBe(false);
    expect((await recordFailureAndMaybeLock("admin", "1.1.1.1", { check: down as any })).locked).toBe(false);
    const throwing = async () => { throw new Error("store down"); };
    expect((await isLockedOut("admin", "1.1.1.1", { check: throwing as any })).locked).toBe(false);
    expect((await recordFailureAndMaybeLock("admin", "1.1.1.1", { check: throwing as any })).locked).toBe(false);
  });

  it("self-heals when the window expires", async () => {
    const { check } = fakeStore();
    for (let i = 0; i < SOFT.failures + 1; i++) {
      await recordFailureAndMaybeLock("admin", "2.2.2.2", { check });
    }
    expect((await isLockedOut("admin", "2.2.2.2", { check })).locked).toBe(true);
    // New store instance simulates post-expiry (window state gone).
    const fresh = fakeStore(SOFT.withinSeconds * 1000 + 1);
    expect((await isLockedOut("admin", "2.2.2.2", { check: fresh.check })).locked).toBe(false);
  });
});
