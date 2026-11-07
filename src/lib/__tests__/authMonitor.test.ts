import { describe, it, expect, beforeEach } from "vitest";
import {
  noteAdminAuthFailure,
  noteOtpRequest,
  getRequestIp,
  _resetAuthMonitorDedupe,
  ATO_LIMITS,
} from "@/lib/security/authMonitor";

import { makeRequestFromIp, makeRateLimitResult } from "./fixtures";

function makeReq(ip?: string): Request {
  return makeRequestFromIp("https://careermonke.com/api/admin/x", ip);
}

const over = makeRateLimitResult({ allowed: false, retryAfter: 60, currentCount: 99 });
const under = makeRateLimitResult();
const down = makeRateLimitResult({ allowed: false, retryAfter: 30, currentCount: 0, source: "unavailable" });

describe("authMonitor (credential-stuffing / ATO detection)", () => {
  beforeEach(() => _resetAuthMonitorDedupe());

  it("stays silent below the threshold", async () => {
    const lines: string[] = [];
    await noteAdminAuthFailure(makeReq("1.2.3.4"), "tok", {
      check: async () => under,
      log: (l) => lines.push(l),
    });
    expect(lines).toEqual([]);
  });

  it("alerts once when the IP failure threshold is crossed, deduped within the window", async () => {
    const lines: string[] = [];
    let t = 1_000_000;
    const deps = {
      check: async () => over,
      log: (l: string) => lines.push(l),
      now: () => t,
    };
    await noteAdminAuthFailure(makeReq("1.2.3.4"), null, deps);
    await noteAdminAuthFailure(makeReq("1.2.3.4"), null, deps);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[ATO-ALERT]");
    expect(lines[0]).toContain("ip=1.2.3.4");

    t += 11 * 60 * 1000; // past the dedupe window -> alerts again
    await noteAdminAuthFailure(makeReq("1.2.3.4"), null, deps);
    expect(lines).toHaveLength(2);
  });

  it("never alerts when the shared store is unavailable (no false alarms)", async () => {
    const lines: string[] = [];
    await noteAdminAuthFailure(makeReq("1.2.3.4"), "tok", {
      check: async () => down,
      log: (l) => lines.push(l),
    });
    expect(lines).toEqual([]);
  });

  it("hashes presented tokens and emails - raw secrets never reach counter keys", async () => {
    const keys: string[] = [];
    const check = async (key: string) => {
      keys.push(key);
      return under;
    };
    await noteAdminAuthFailure(makeReq("1.2.3.4"), "super-secret-token", { check, log: () => {} });
    await noteOtpRequest(makeReq("1.2.3.4"), "Person@Example.com", { check, log: () => {} });
    for (const k of keys) {
      expect(k).not.toContain("super-secret-token");
      expect(k.toLowerCase()).not.toContain("person@example.com");
    }
    expect(keys.some((k) => k.startsWith("ato:admin:tok:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("ato:otp:email:"))).toBe(true);
  });

  it("normalizes email case before hashing (same account, one counter)", async () => {
    const keys: string[] = [];
    const check = async (key: string) => {
      keys.push(key);
      return under;
    };
    await noteOtpRequest(makeReq(), "Person@Example.com", { check, log: () => {} });
    await noteOtpRequest(makeReq(), "person@example.com", { check, log: () => {} });
    const emailKeys = keys.filter((k) => k.startsWith("ato:otp:email:"));
    expect(new Set(emailKeys).size).toBe(1);
  });

  it("swallows monitoring errors - the auth path never breaks", async () => {
    await expect(
      noteAdminAuthFailure(makeReq(), "tok", {
        check: async () => {
          throw new Error("store exploded");
        },
        log: () => {},
      })
    ).resolves.toBeUndefined();
  });

  it("reads the client IP from x-forwarded-for / x-real-ip", () => {
    expect(getRequestIp(makeReq("9.9.9.9, 10.0.0.1"))).toBe("9.9.9.9");
    const h = new Headers({ "x-real-ip": "8.8.8.8" });
    expect(getRequestIp(new Request("https://x.test", { headers: h }))).toBe("8.8.8.8");
    expect(getRequestIp(undefined)).toBe("unknown");
  });

  it("thresholds are explicit, tunable constants", () => {
    for (const cfg of Object.values(ATO_LIMITS)) {
      expect(cfg.max).toBeGreaterThan(0);
      expect(cfg.windowSeconds).toBeGreaterThan(0);
    }
  });
});
